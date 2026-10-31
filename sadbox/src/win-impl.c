#define NAPI_VERSION 8
#include <node_api.h>

#include <windows.h>
#include <wchar.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <bcrypt.h>

/* ------------------------------------------------------------------ */
/* SbieDll.dll dynamic bindings                                        */
/* ------------------------------------------------------------------ */

typedef LONG   (__stdcall *PFN_EnumBoxesEx)(LONG, WCHAR*, BOOLEAN);
typedef LONG   (__stdcall *PFN_IsBoxEnabled)(const WCHAR*);
typedef LONG   (__stdcall *PFN_QueryBoxPath)(const WCHAR*, WCHAR*, WCHAR*, WCHAR*, ULONG*, ULONG*, ULONG*);
typedef LONG   (__stdcall *PFN_QueryConf)(const WCHAR*, const WCHAR*, ULONG, WCHAR*, ULONG);
typedef LONG   (__stdcall *PFN_EnumProcessEx)(const WCHAR*, BOOLEAN, ULONG, ULONG*, ULONG*);
typedef LONG   (__stdcall *PFN_QueryProcess)(HANDLE, WCHAR*, WCHAR*, WCHAR*, ULONG*);
typedef LONG   (__stdcall *PFN_ReloadConf)(ULONG, ULONG);
typedef BOOL   (__stdcall *PFN_RunSandboxed)(const WCHAR*, const WCHAR*, const WCHAR*, ULONG, STARTUPINFO*, PROCESS_INFORMATION*);
typedef BOOLEAN(__stdcall *PFN_KillAll)(ULONG, const WCHAR*);
typedef BOOLEAN(__stdcall *PFN_KillOne)(ULONG);
typedef ULONG  (__stdcall *PFN_UpdateConf)(WCHAR, const WCHAR*, const WCHAR*, const WCHAR*, const WCHAR*);
typedef BOOLEAN(__stdcall *PFN_TranslateNtToDosPath)(WCHAR*);

static PFN_EnumBoxesEx         pEnumBoxesEx;
static PFN_IsBoxEnabled        pIsBoxEnabled;
static PFN_QueryBoxPath        pQueryBoxPath;
static PFN_QueryConf           pQueryConf;
static PFN_EnumProcessEx       pEnumProcessEx;
static PFN_QueryProcess        pQueryProcess;
static PFN_ReloadConf          pReloadConf;
static PFN_RunSandboxed        pRunSandboxed;
static PFN_KillAll             pKillAll;
static PFN_KillOne             pKillOne;
static PFN_UpdateConf          pUpdateConf;
static PFN_TranslateNtToDosPath pTranslateNtToDosPath;

static HMODULE sbie_hm = NULL;
static int sbie_loaded = 0;   /* 0 = not tried, 1 = ok, -1 = failed */

#define LOAD_PFN(cptr, expname)                                             \
    do {                                                                    \
        *(void **)&(cptr) = (void *)GetProcAddress((h), (expname));         \
        if (!(cptr)) { sbie_loaded = -1; return -1; }                       \
    } while (0)

static int sbie_load(const wchar_t *install_path)
{
    if (sbie_loaded == 1) return 0;

    HMODULE h = NULL;

    /* explicit install path from createSandbox({ path }) */
    if (install_path && install_path[0]) {
        wchar_t dll[MAX_PATH];
        wsprintfW(dll, L"%s\\SbieDll.dll", install_path);
        h = LoadLibraryW(dll);
    }
    /* well-known install locations */
    if (!h) h = LoadLibraryW(L"C:\\Program Files\\Sandboxie-Plus\\SbieDll.dll");
    if (!h) h = LoadLibraryW(L"C:\\Program Files\\Sandboxie\\SbieDll.dll");
    /* loader search path / current directory */
    if (!h) h = LoadLibraryW(L"SbieDll.dll");
    if (!h) { sbie_loaded = -1; return -1; }

    sbie_hm = h;

    LOAD_PFN(pEnumBoxesEx,         "SbieApi_EnumBoxesEx");
    LOAD_PFN(pIsBoxEnabled,        "SbieApi_IsBoxEnabled");
    LOAD_PFN(pQueryBoxPath,        "SbieApi_QueryBoxPath");
    LOAD_PFN(pQueryConf,           "SbieApi_QueryConf");
    LOAD_PFN(pEnumProcessEx,       "SbieApi_EnumProcessEx");
    LOAD_PFN(pQueryProcess,        "SbieApi_QueryProcess");
    LOAD_PFN(pReloadConf,          "SbieApi_ReloadConf");
    LOAD_PFN(pRunSandboxed,        "SbieDll_RunSandboxed");
    LOAD_PFN(pKillAll,             "SbieDll_KillAll");
    LOAD_PFN(pKillOne,             "SbieDll_KillOne");
    LOAD_PFN(pUpdateConf,          "SbieDll_UpdateConf");
    LOAD_PFN(pTranslateNtToDosPath,"SbieDll_TranslateNtToDosPath");

    sbie_loaded = 1;
    return 0;
}

/* ------------------------------------------------------------------ */
/* N-API helpers                                                       */
/* ------------------------------------------------------------------ */

/*
 * Sandboxie hard-caps sandbox section names at 40 characters (BOXNAME_LEN).
 */
#define BOXNAME_LEN 40
#define PREFIX_LEN  20   /* "SJ_" + 16 hex chars + "_" */
#define MAX_ID_LEN  20
#define SECTION_LEN (BOXNAME_LEN + 1) /* NUL */
#define MAX_PATH_W  4096

_Static_assert(PREFIX_LEN + MAX_ID_LEN <= BOXNAME_LEN,
               "prefix + id must fit Sandboxie's 40-char box-name limit");

static napi_value throw_error(napi_env env, const char *code, const char *msg)
{
    napi_throw_error(env, code, msg);
    return NULL;
}

static napi_value throw_ntstatus(napi_env env, LONG status)
{
    char msg[256];
    sprintf(msg, "Sandboxie call failed with NTSTATUS 0x%08lX", (ULONG)status);
    return throw_error(env, "ESBIE", msg);
}

/*
 * Read a JS string into a caller-supplied buffer.  Fails if the value is
 * not a string or does not fit in `cap` wchar_t cells (cap includes the NUL
 * terminator).  Never silently truncates.
 */
static int get_utf16(napi_env env, napi_value val, wchar_t *buf, size_t cap)
{
    if (cap == 0) return -1;
    buf[0] = L'\0';
    size_t len = 0;
    if (napi_get_value_string_utf16(env, val, NULL, 0, &len) != napi_ok)
        return -1;
    if (len + 1 > cap)
        return -1;
    return napi_get_value_string_utf16(env, val, buf, cap, NULL) == napi_ok ? 0 : -1;
}

/* Read a JS string into a freshly allocated buffer (exact length + NUL). */
static wchar_t *get_utf16_alloc(napi_env env, napi_value val, size_t *out_len)
{
    size_t len = 0;
    if (napi_get_value_string_utf16(env, val, NULL, 0, &len) != napi_ok)
        return NULL;
    wchar_t *s = (wchar_t *)malloc((len + 1) * sizeof(wchar_t));
    if (!s) return NULL;
    if (napi_get_value_string_utf16(env, val, s, len + 1, NULL) != napi_ok) {
        free(s);
        return NULL;
    }
    if (out_len) *out_len = len;
    return s;
}

/* Finalizers: release the C structs when the JS objects are GC'd. */
static void free_manager_data(napi_env env, void *data, void *hint)
{ (void)env; (void)hint; free(data); }
static void free_sandbox_data(napi_env env, void *data, void *hint)
{ (void)env; (void)hint; free(data); }

static napi_value make_wstr(napi_env env, const wchar_t *ws)
{
    napi_value v;
    napi_create_string_utf16(env, ws, wcslen(ws), &v);
    return v;
}

static wchar_t **read_string_array(napi_env env, napi_value obj, const char *prop,
                                   int *out_count)
{
    *out_count = 0;
    napi_value arr;
    bool has = false;
    if (napi_has_named_property(env, obj, prop, &has) != napi_ok || !has)
        return NULL;
    if (napi_get_named_property(env, obj, prop, &arr) != napi_ok)
        return NULL;

    bool is_array = false;
    napi_is_array(env, arr, &is_array);
    if (!is_array)
        return NULL;

    uint32_t n = 0;
    napi_get_array_length(env, arr, &n);
    if (n == 0)
        return NULL;

    wchar_t **out = (wchar_t **)calloc(n, sizeof(wchar_t *));
    if (!out) return NULL;

    for (uint32_t i = 0; i < n; i++) {
        napi_value el;
        if (napi_get_element(env, arr, i, &el) != napi_ok)
            continue;
        wchar_t *s = get_utf16_alloc(env, el, NULL);
        if (!s || !s[0]) {   /* skip non-strings and empty entries */
            free(s);
            continue;
        }
        out[(*out_count)++] = s;
    }
    return out;
}

static void free_string_array(wchar_t **arr, int count)
{
    if (!arr) return;
    for (int i = 0; i < count; i++) free(arr[i]);
    free(arr);
}

/* ------------------------------------------------------------------ */
/* Shared native helpers (operate on a full section name)              */
/* ------------------------------------------------------------------ */

static int caller_is_in_box(const wchar_t *section)
{
    if (!pQueryProcess) return 0;
    WCHAR mybox[SECTION_LEN] = {0};
    LONG rc = pQueryProcess((HANDLE)(ULONG_PTR)GetCurrentProcessId(), mybox, NULL, NULL, NULL);
    if (rc != 0) return 0;
    return _wcsicmp(mybox, section) == 0;
}

static int guard_self_destruction(napi_env env, const wchar_t *section)
{
    if (caller_is_in_box(section)) {
        napi_throw_error(env, "ESELF",
            "refusing to terminate/delete the sandbox this process runs inside");
        return -1;
    }
    return 0;
}

static LONG box_get_path_dos(const wchar_t *box, wchar_t *out, ULONG out_wchars)
{
    ULONG len = 0;
    LONG rc = pQueryBoxPath(box, NULL, NULL, NULL, &len, NULL, NULL);
    if (rc != 0) return rc;
    if (len / sizeof(wchar_t) >= out_wchars)
        return (LONG)0xC0000023; /* STATUS_BUFFER_TOO_SMALL */
    ULONG cap = out_wchars * sizeof(wchar_t);
    rc = pQueryBoxPath(box, out, NULL, NULL, &cap, NULL, NULL);
    if (rc != 0) return rc;
    pTranslateNtToDosPath(out);
    return 0;
}

static LONG delete_directory_tree(const wchar_t *dir)
{
    WCHAR longdir[MAX_PATH_W];
    if (_wcsnicmp(dir, L"\\\\?\\", 4) == 0) wcscpy(longdir, dir);
    else wsprintfW(longdir, L"\\\\?\\%s", dir);

    WCHAR search[MAX_PATH_W];
    wsprintfW(search, L"%s\\*", longdir);

    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(search, &fd);
    if (hFind == INVALID_HANDLE_VALUE)
        return 0;

    LONG result = 0;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0)
            continue;
        WCHAR child[MAX_PATH_W];
        wsprintfW(child, L"%s\\%s", longdir, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
                RemoveDirectoryW(child);
            else
                delete_directory_tree(child);
        } else {
            SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL);
            DeleteFileW(child);
        }
    } while (FindNextFileW(hFind, &fd));

    FindClose(hFind);
    SetFileAttributesW(longdir, FILE_ATTRIBUTE_NORMAL);
    RemoveDirectoryW(longdir);
    return result;
}

static LONG delete_box_folder(const wchar_t *box)
{
    wchar_t root[MAX_PATH_W];
    LONG rc = box_get_path_dos(box, root, MAX_PATH_W);
    if (rc != 0) return 0; /* virtual box / no folder */

    WIN32_FIND_DATAW fd;
    WCHAR search[MAX_PATH_W];
    wsprintfW(search, L"%s\\*", root);
    HANDLE hFind = FindFirstFileW(search, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return 0;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0)
            continue;
        WCHAR child[MAX_PATH_W];
        wsprintfW(child, L"%s\\%s", root, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
            delete_directory_tree(child);
        else {
            SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL);
            DeleteFileW(child);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);

    /* remove the box root itself, not just its contents */
    WCHAR longroot[MAX_PATH_W];
    if (_wcsnicmp(root, L"\\\\?\\", 4) == 0) wcscpy(longroot, root);
    else wsprintfW(longroot, L"\\\\?\\%s", root);
    SetFileAttributesW(longroot, FILE_ATTRIBUTE_NORMAL);
    RemoveDirectoryW(longroot);
    return 0;
}

/* remove every value line of a multi-valued setting (idempotent re-apply) */
#define CONF_GET_NO_EXPAND 0x20000000L
#define CONF_GET_NO_GLOBAL 0x40000000L

static void remove_setting_lines(const wchar_t *box, const wchar_t *setting)
{
    for (ULONG idx = 0; idx < 512; idx++) {
        WCHAR value[1024] = {0};
        /* enumerate only this section's own lines (no global fallback) */
        LONG rc = pQueryConf(box, setting, idx | CONF_GET_NO_GLOBAL | CONF_GET_NO_EXPAND,
                             value, sizeof(value));
        if (rc != 0) break;
        pUpdateConf(L'd', L"", box, setting, value);
    }
}

static void sha256_hex16(const void *data, size_t len, char out[17])
{
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    BYTE digest[32];
    out[0] = 0;

    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0)
        return;
    if (BCryptCreateHash(alg, &hash, NULL, 0, NULL, 0, 0) != 0) {
        BCryptCloseAlgorithmProvider(alg, 0);
        return;
    }
    BCryptHashData(hash, (PUCHAR)data, (ULONG)len, 0);
    BCryptFinishHash(hash, digest, sizeof(digest), 0);
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(alg, 0);

    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 8; i++) {
        out[i * 2]     = hex[digest[i] >> 4];
        out[i * 2 + 1] = hex[digest[i] & 0xF];
    }
    out[16] = 0;
}

static void build_prefix(wchar_t *prefix, size_t prefix_wchars, const wchar_t *key)
{
    const wchar_t *k = (key && key[0]) ? key : L"default";
    char hash[17];
    sha256_hex16(k, wcslen(k) * sizeof(wchar_t), hash);

    char tmp[64];
    sprintf(tmp, "SJ_%s_", hash);
    mbstowcs(prefix, tmp, prefix_wchars);
    prefix[prefix_wchars - 1] = 0;
}

static int valid_id(const wchar_t *id) {
    size_t len = wcslen(id);
    if (len == 0 || len > MAX_ID_LEN) return 0;
    for (size_t i = 0; i < len; i++) {
        wchar_t c = id[i];
        if (c <= ' ') return 0;
    }
    return 1;
}

static void mkdirs(const wchar_t *path) {
    WCHAR tmp[MAX_PATH_W];
    wcsncpy(tmp, path, MAX_PATH_W - 1);
    tmp[MAX_PATH_W - 1] = 0;

    /* normalize separators */
    for (WCHAR *c = tmp; *c; c++)
        if (*c == L'/') *c = L'\\';

    /* walk components below the drive root "X:\" */
    WCHAR *p = tmp;
    if (p[0] && p[1] == L':' && p[2] == L'\\') p += 3;
    else if (p[0] == L'\\' && p[1] == L'\\') { p += 2; while (*p && *p != L'\\') p++; if (*p) p++; }
    while (*p) {
        if (*p == L'\\') {
            *p = 0;
            CreateDirectoryW(tmp, NULL); /* ignore ERROR_ALREADY_EXISTS */
            *p = L'\\';
        }
        p++;
    }
    CreateDirectoryW(tmp, NULL);
}

/* ------------------------------------------------------------------ */
/* Instance data                                                       */
/* ------------------------------------------------------------------ */

typedef struct {
    wchar_t prefix[PREFIX_LEN + 1];
} ManagerData;

typedef struct {
    wchar_t section[SECTION_LEN];
    wchar_t storage[MAX_PATH_W];
} SandboxData;

/* persistent references to the classes defined in Init() */
static napi_ref manager_class_ref = NULL;
static napi_ref sandbox_class_ref = NULL;

/* create a new instance of one of our classes (persistent class reference) */
static int new_class_instance(napi_env env, napi_ref cls_ref, napi_value *out)
{
    napi_value cls;
    if (napi_get_reference_value(env, cls_ref, &cls) != napi_ok)
        return -1;
    return (napi_new_instance(env, cls, 0, NULL, out) == napi_ok) ? 0 : -1;
}

/* ------------------------------------------------------------------ */
/* Sandbox class                                                       */
/* ------------------------------------------------------------------ */

/*
 * start(command: string, options?: { cwd?: string }) -> pid
 */
static napi_value Sandbox_Start(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2], thisv;
    napi_get_cb_info(env, info, &argc, argv, &thisv, NULL);
    if (argc < 1) return throw_error(env, "EARG", "start(command, options?) requires a command string");

    SandboxData *sd = NULL;
    napi_unwrap(env, thisv, (void **)&sd);
    if (!sd) return throw_error(env, "EINVAL", "Illegal invocation");

    size_t cmd_len = 0;
    wchar_t *cmd = get_utf16_alloc(env, argv[0], &cmd_len);
    if (!cmd) return throw_error(env, "EARG", "invalid command");
    if (cmd_len == 0) { free(cmd); return throw_error(env, "EARG", "empty command"); }

    /* cwd: optional, defaults to C:\ */
    wchar_t cwd[MAX_PATH_W] = {0};
    wcscpy(cwd, L"C:\\");
    if (argc >= 2) {
        napi_valuetype vt;
        if (napi_typeof(env, argv[1], &vt) == napi_ok && vt == napi_object) {
            bool has = false;
            if (napi_has_named_property(env, argv[1], "cwd", &has) == napi_ok && has) {
                napi_value cv;
                napi_get_named_property(env, argv[1], "cwd", &cv);
                if (get_utf16(env, cv, cwd, MAX_PATH_W) != 0) {
                    free(cmd);
                    return throw_error(env, "EARG", "invalid cwd");
                }
                for (WCHAR *c = cwd; *c; c++)
                    if (*c == L'/') *c = L'\\';
            }
        }
    }

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
    ZeroMemory(&pi, sizeof(pi));

    BOOL ok = pRunSandboxed(sd->section, cmd, cwd, 0, (STARTUPINFO *)(void *)&si, &pi);
    free(cmd);
    if (!ok) {
        char msg[256];
        sprintf(msg, "SbieDll_RunSandboxed failed, last error = %lu", (ULONG)GetLastError());
        return throw_error(env, "ESTART", msg);
    }

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    napi_value pid;
    napi_create_uint32(env, pi.dwProcessId, &pid);
    return pid;
}

static napi_value Sandbox_Kill(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], thisv;
    napi_get_cb_info(env, info, &argc, argv, &thisv, NULL);
    if (argc < 1) return throw_error(env, "EARG", "kill(pid) requires a pid");

    uint32_t pid = 0;
    if (napi_get_value_uint32(env, argv[0], &pid) != napi_ok)
        return throw_error(env, "EARG", "invalid pid");

    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) {
        napi_value v;
        napi_get_boolean(env, false, &v);
        return v;
    }
    CloseHandle(h);

    BOOLEAN ok = pKillOne(pid);
    if (!ok) return throw_error(env, "EKILL", "SbieDll_KillOne failed");

    napi_value v;
    napi_get_boolean(env, true, &v);
    return v;
}

static napi_value Sandbox_KillAll(napi_env env, napi_callback_info info)
{
    napi_value thisv;
    napi_get_cb_info(env, info, NULL, NULL, &thisv, NULL);
    SandboxData *sd = NULL;
    napi_unwrap(env, thisv, (void **)&sd);
    if (!sd) return throw_error(env, "EINVAL", "Illegal invocation");
    if (guard_self_destruction(env, sd->section) != 0) return NULL;

    pKillAll((ULONG)-1, sd->section);
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value Sandbox_ListPids(napi_env env, napi_callback_info info)
{
    napi_value thisv;
    napi_get_cb_info(env, info, NULL, NULL, &thisv, NULL);
    SandboxData *sd = NULL;
    napi_unwrap(env, thisv, (void **)&sd);
    if (!sd) return throw_error(env, "EINVAL", "Illegal invocation");

    ULONG count = 0;
    LONG rc = pEnumProcessEx(sd->section, TRUE, -1, NULL, &count);
    if (rc != 0) return throw_ntstatus(env, rc);
    if (count > 512) count = 512;

    ULONG pids[512] = {0};
    ULONG cap = count;
    rc = pEnumProcessEx(sd->section, TRUE, -1, pids, &cap);
    if (rc != 0) return throw_ntstatus(env, rc);

    napi_value arr;
    napi_create_array_with_length(env, cap, &arr);
    for (ULONG i = 0; i < cap; i++) {
        napi_value el;
        napi_create_uint32(env, pids[i], &el);
        napi_set_element(env, arr, i, el);
    }
    return arr;
}

static napi_value Sandbox_GetStoragePath(napi_env env, napi_callback_info info)
{
    napi_value thisv;
    napi_get_cb_info(env, info, NULL, NULL, &thisv, NULL);
    SandboxData *sd = NULL;
    napi_unwrap(env, thisv, (void **)&sd);
    if (!sd) return throw_error(env, "EINVAL", "Illegal invocation");
    return make_wstr(env, sd->storage);
}

/* ------------------------------------------------------------------ */
/* SandboxManager class                                                */
/* ------------------------------------------------------------------ */

static napi_value Manager_Create(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value argv[2], thisv;
    napi_get_cb_info(env, info, &argc, argv, &thisv, NULL);
    if (argc < 2) return throw_error(env, "EARG", "create(id, policy) requires two arguments");

    ManagerData *md = NULL;
    napi_unwrap(env, thisv, (void **)&md);
    if (!md) return throw_error(env, "EINVAL", "Illegal invocation");

    size_t id_len = 0;
    wchar_t *id = get_utf16_alloc(env, argv[0], &id_len);
    if (!id) return throw_error(env, "EARG", "invalid id");
    if (!valid_id(id)) {
        free(id);
        return throw_error(env, "EARG", "invalid id");
    }

    wchar_t section[SECTION_LEN];
    wsprintfW(section, L"%s%s", md->prefix, id);
    free(id);

    /* ---- ensure the section exists ---- */
    LONG rc = pUpdateConf(L's', L"", section, L"Enabled", L"y");
    if (rc != 0) return throw_ntstatus(env, rc);

    /* ---- apply policy (remove old values first => idempotent) ---- */
    remove_setting_lines(section, L"WriteDirectPath");
    remove_setting_lines(section, L"ClosedFilePath");
    remove_setting_lines(section, L"BlockNetworkFiles");
    remove_setting_lines(section, L"Template");
    remove_setting_lines(section, L"BoxRootFolder");
    remove_setting_lines(section, L"FileRootPath");

    /* fileWhitelist -> WriteDirectPath */
    int wcount = 0;
    wchar_t **wl = read_string_array(env, argv[1], "fileWhitelist", &wcount);
    for (int i = 0; i < wcount; i++) {
        rc = pUpdateConf(L'a', L"", section, L"WriteDirectPath", wl[i]);
        if (rc != 0) { free_string_array(wl, wcount); return throw_ntstatus(env, rc); }
    }
    free_string_array(wl, wcount);

    /* fileBlacklist -> ClosedFilePath */
    int bcount = 0;
    wchar_t **bl = read_string_array(env, argv[1], "fileBlacklist", &bcount);
    for (int i = 0; i < bcount; i++) {
        rc = pUpdateConf(L'a', L"", section, L"ClosedFilePath", bl[i]);
        if (rc != 0) { free_string_array(bl, bcount); return throw_ntstatus(env, rc); }
    }
    free_string_array(bl, bcount);

    /* network */
    bool network = true;
    napi_value nv;
    if (napi_get_named_property(env, argv[1], "network", &nv) == napi_ok) {
        napi_get_value_bool(env, nv, &network);
    }
    if (!network) {
        pUpdateConf(L's', L"", section, L"BlockNetworkFiles", L"y");
        pUpdateConf(L'a', L"", section, L"Template", L"BlockPorts");
    }

    /* storagePath -> FileRootPath (modern equivalent of BoxRootFolder).
     * BoxRootFolder is legacy and expects an NT path; FileRootPath accepts a
     * plain DOS path. */
    wchar_t storage[MAX_PATH_W] = {0};
    bool has_storage = false;
    if (napi_has_named_property(env, argv[1], "storagePath", &has_storage) == napi_ok && has_storage) {
        napi_value sv;
        if (napi_get_named_property(env, argv[1], "storagePath", &sv) == napi_ok)
            if (get_utf16(env, sv, storage, MAX_PATH_W) != 0)
                return throw_error(env, "EARG", "invalid storagePath");
        if (storage[0]) {
            /* normalize separators and make sure the base exists */
            for (WCHAR *c = storage; *c; c++)
                if (*c == L'/') *c = L'\\';
            mkdirs(storage);
            pUpdateConf(L's', L"", section, L"FileRootPath", storage);
        }
    }

    /* reload config so the driver picks up the new policy */
    pReloadConf((ULONG)-1, 0);

    /* resolve the effective storage path */
    wchar_t path[MAX_PATH_W] = {0};
    rc = box_get_path_dos(section, path, MAX_PATH_W);
    if (rc != 0) return throw_ntstatus(env, rc);

    /* ---- build the Sandbox instance ---- */
    napi_value sbox;
    if (new_class_instance(env, sandbox_class_ref, &sbox) != 0)
        return throw_error(env, "EINIT", "failed to create Sandbox instance");

    SandboxData *sd = (SandboxData *)calloc(1, sizeof(SandboxData));
    if (!sd) return throw_error(env, "EMEM", "out of memory");
    wcscpy(sd->section, section);
    wcscpy(sd->storage, path);

    if (napi_wrap(env, sbox, sd, free_sandbox_data, NULL, NULL) != napi_ok) {
        free(sd);
        return throw_error(env, "EWRAP", "failed to wrap Sandbox instance");
    }
    return sbox;
}

static napi_value Manager_Delete(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], thisv;
    napi_get_cb_info(env, info, &argc, argv, &thisv, NULL);
    if (argc < 1) return throw_error(env, "EARG", "delete(id) requires an id");

    ManagerData *md = NULL;
    napi_unwrap(env, thisv, (void **)&md);
    if (!md) return throw_error(env, "EINVAL", "Illegal invocation");

    size_t id_len = 0;
    wchar_t *id = get_utf16_alloc(env, argv[0], &id_len);
    if (!id) return throw_error(env, "EARG", "invalid id");
    if (!valid_id(id)) {
        free(id);
        return throw_error(env, "EARG", "invalid id");
    }

    wchar_t section[SECTION_LEN];
    wsprintfW(section, L"%s%s", md->prefix, id);
    free(id);

    if (guard_self_destruction(env, section) != 0) return NULL;

    pKillAll((ULONG)-1, section);
    delete_box_folder(section);
    pUpdateConf(L's', L"", section, L"*", NULL);
    pReloadConf((ULONG)-1, 0);

    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value Manager_DeleteAll(napi_env env, napi_callback_info info)
{
    napi_value thisv;
    napi_get_cb_info(env, info, NULL, NULL, &thisv, NULL);
    ManagerData *md = NULL;
    napi_unwrap(env, thisv, (void **)&md);
    if (!md) return throw_error(env, "EINVAL", "Illegal invocation");

    napi_value undef;
    napi_get_undefined(env, &undef);

    LONG idx = -1;
    while (1) {
        WCHAR section[SECTION_LEN] = {0};
        LONG rc = pEnumBoxesEx(idx, section, TRUE);
        if (rc == -1) break;
        idx = rc;
        if (wcsncmp(section, md->prefix, wcslen(md->prefix)) != 0)
            continue;
        if (guard_self_destruction(env, section) != 0)
            continue;
        pKillAll((ULONG)-1, section);
        delete_box_folder(section);
        pUpdateConf(L's', L"", section, L"*", NULL);
    }
    pReloadConf((ULONG)-1, 0);
    return undef;
}

static napi_value Manager_List(napi_env env, napi_callback_info info)
{
    napi_value thisv;
    napi_get_cb_info(env, info, NULL, NULL, &thisv, NULL);
    ManagerData *md = NULL;
    napi_unwrap(env, thisv, (void **)&md);
    if (!md) return throw_error(env, "EINVAL", "Illegal invocation");

    napi_value arr;
    napi_create_array(env, &arr);
    uint32_t n = 0;

    LONG idx = -1;
    while (1) {
        WCHAR section[SECTION_LEN] = {0};
        LONG rc = pEnumBoxesEx(idx, section, TRUE);
        if (rc == -1) break;
        idx = rc;

        size_t plen = wcslen(md->prefix);
        if (wcsncmp(section, md->prefix, plen) != 0)
            continue;

        napi_value sbox;
        if (new_class_instance(env, sandbox_class_ref, &sbox) != 0)
            break;

        SandboxData *sd = (SandboxData *)calloc(1, sizeof(SandboxData));
        if (!sd) break;
        wcscpy(sd->section, section);

        wchar_t path[MAX_PATH_W] = {0};
        if (box_get_path_dos(section, path, MAX_PATH_W) == 0)
            wcscpy(sd->storage, path);

        if (napi_wrap(env, sbox, sd, free_sandbox_data, NULL, NULL) != napi_ok) {
            free(sd);
            break;
        }
        napi_set_element(env, arr, n++, sbox);
    }

    return arr;
}

/* ------------------------------------------------------------------ */
/* Module bootstrap                                                    */
/* ------------------------------------------------------------------ */

static napi_value Class_Constructor(napi_env env, napi_callback_info info)
{
    (void)env; (void)info;
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value createSandbox(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

    wchar_t install_path[MAX_PATH_W] = {0};
    wchar_t prefix_key[MAX_PATH_W] = {0};
    if (argc >= 1) {
        napi_valuetype vt;
        if (napi_typeof(env, argv[0], &vt) == napi_ok && vt == napi_object) {
            bool has = false;
            if (napi_has_named_property(env, argv[0], "path", &has) == napi_ok && has) {
                napi_value pv;
                napi_get_named_property(env, argv[0], "path", &pv);
                if (get_utf16(env, pv, install_path, MAX_PATH_W) != 0)
                    return throw_error(env, "EARG", "invalid options.path");
            }
            if (napi_has_named_property(env, argv[0], "namespace", &has) == napi_ok && has) {
                napi_value pv;
                napi_get_named_property(env, argv[0], "namespace", &pv);
                if (get_utf16(env, pv, prefix_key, MAX_PATH_W) != 0)
                    return throw_error(env, "EARG", "invalid options.namespace");
            }
        }
    }

    if (sbie_load(install_path) != 0) {
        char msg[256];
        sprintf(msg, "failed to load SbieDll.dll (last error %lu)", (ULONG)GetLastError());
        return throw_error(env, "ESBIEDLL", msg);
    }

    napi_value mgr;
    if (new_class_instance(env, manager_class_ref, &mgr) != 0)
        return throw_error(env, "EINIT", "failed to create SandboxManager instance");

    ManagerData *md = (ManagerData *)calloc(1, sizeof(ManagerData));
    if (!md) return throw_error(env, "EMEM", "out of memory");
    build_prefix(md->prefix, sizeof(md->prefix) / sizeof(wchar_t), prefix_key);

    if (napi_wrap(env, mgr, md, free_manager_data, NULL, NULL) != napi_ok) {
        free(md);
        return throw_error(env, "EWRAP", "failed to wrap SandboxManager instance");
    }
    return mgr;
}

/* diagnostic exports (useful for verification) */
static napi_value diag_isSandboxed(napi_env env, napi_callback_info info)
{
    (void)info;
    if (sbie_load(NULL) != 0) return throw_error(env, "ESBIEDLL", "SbieDll.dll not loaded");

    napi_value v;
    napi_get_boolean(env,
        pQueryProcess &&
        pQueryProcess((HANDLE)(ULONG_PTR)GetCurrentProcessId(), NULL, NULL, NULL, NULL) == 0,
        &v);
    return v;
}

static napi_value diag_getVersion(napi_env env, napi_callback_info info)
{
    (void)info;
    if (sbie_load(NULL) != 0) return throw_error(env, "ESBIEDLL", "SbieDll.dll not loaded");

    typedef LONG(__stdcall *PFN_GetVersion)(WCHAR*);
    PFN_GetVersion gv = (PFN_GetVersion)GetProcAddress(sbie_hm, "SbieApi_GetVersion");
    if (!gv) return throw_error(env, "ESBIE", "SbieApi_GetVersion not exported");
    wchar_t ver[32] = {0};
    gv(ver);
    return make_wstr(env, ver);
}

static napi_value diag_getBoxPath(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc < 1) return throw_error(env, "EARG", "getBoxPath(name) requires a name");
    if (sbie_load(NULL) != 0) return throw_error(env, "ESBIEDLL", "SbieDll.dll not loaded");

    wchar_t box[SECTION_LEN];
    if (get_utf16(env, argv[0], box, SECTION_LEN) != 0)
        return throw_error(env, "EARG", "invalid box name");

    ULONG flen = 0, klen = 0, ilen = 0;
    LONG rc = pQueryBoxPath(box, NULL, NULL, NULL, &flen, &klen, &ilen);
    if (rc != 0) return throw_ntstatus(env, rc);

    wchar_t fp[MAX_PATH_W] = {0}, kp[MAX_PATH_W] = {0}, ip[MAX_PATH_W] = {0};
    ULONG f2 = sizeof(fp), k2 = sizeof(kp), i2 = sizeof(ip);
    rc = pQueryBoxPath(box, fp, kp, ip, &f2, &k2, &i2);
    if (rc != 0) return throw_ntstatus(env, rc);
    pTranslateNtToDosPath(fp);

    napi_value obj;
    napi_create_object(env, &obj);
    napi_set_named_property(env, obj, "file", make_wstr(env, fp));
    napi_set_named_property(env, obj, "key", make_wstr(env, kp));
    napi_set_named_property(env, obj, "ipc", make_wstr(env, ip));
    return obj;
}

static napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor manager_props[] = {
        { "create",    NULL, Manager_Create,    NULL, NULL, NULL, napi_default_method, NULL },
        { "delete",    NULL, Manager_Delete,    NULL, NULL, NULL, napi_default_method, NULL },
        { "deleteAll", NULL, Manager_DeleteAll, NULL, NULL, NULL, napi_default_method, NULL },
        { "list",      NULL, Manager_List,      NULL, NULL, NULL, napi_default_method, NULL },
    };
    napi_property_descriptor sandbox_props[] = {
        { "start",          NULL, Sandbox_Start,          NULL, NULL, NULL, napi_default_method, NULL },
        { "kill",           NULL, Sandbox_Kill,           NULL, NULL, NULL, napi_default_method, NULL },
        { "killAll",        NULL, Sandbox_KillAll,        NULL, NULL, NULL, napi_default_method, NULL },
        { "listPids",       NULL, Sandbox_ListPids,       NULL, NULL, NULL, napi_default_method, NULL },
        { "getStoragePath", NULL, Sandbox_GetStoragePath, NULL, NULL, NULL, napi_default_method, NULL },
    };

    napi_value manager_class, sandbox_class;
    napi_define_class(env, "SandboxManager", NAPI_AUTO_LENGTH, Class_Constructor, NULL,
                      4, manager_props, &manager_class);
    napi_define_class(env, "Sandbox", NAPI_AUTO_LENGTH, Class_Constructor, NULL,
                      5, sandbox_props, &sandbox_class);
    napi_create_reference(env, manager_class, 1, &manager_class_ref);
    napi_create_reference(env, sandbox_class, 1, &sandbox_class_ref);

    napi_property_descriptor exp[] = {
        { "createSandbox", NULL, createSandbox,     NULL, NULL, NULL, napi_default_jsproperty, NULL },
        { "isSandboxed",   NULL, diag_isSandboxed,  NULL, NULL, NULL, napi_default_jsproperty, NULL },
        { "getVersion",    NULL, diag_getVersion,   NULL, NULL, NULL, napi_default_jsproperty, NULL },
        { "getBoxPath",    NULL, diag_getBoxPath,   NULL, NULL, NULL, napi_default_jsproperty, NULL },
    };
    napi_define_properties(env, exports, 4, exp);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
