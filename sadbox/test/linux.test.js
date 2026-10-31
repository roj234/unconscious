// linux.test.js - sadbox Linux verification
//
// Requires: bubblewrap (bwrap), and either root or fuse-overlayfs + /dev/fuse.
// Skips when not on Linux, when running inside a sandbox, or when the
// preflight checks fail.
import test from 'node:test'
import assert from 'node:assert/strict'
import {createSandbox, getBoxPath, getVersion, isSandboxed} from '../src/sadbox.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const isLinux = process.platform === 'linux'

test('linux: module loads and reports version', (t) => {
    if (!isLinux) { t.skip('not linux'); return }
    assert.equal(typeof getVersion(), 'string')
    assert.ok(getVersion().length > 0)
    console.log('  version:', getVersion(), '| isSandboxed:', isSandboxed)
})

test('linux: getBoxPath returns the sandbox dir structure', (t) => {
    if (!isLinux) { t.skip('not linux'); return }
    const p = getBoxPath('SJ_0123456789abcdef_test')
    for (const k of ['root', 'upper', 'work', 'merge']) {
        assert.equal(typeof p[k], 'string')
        assert.ok(p[k].length > 0, `${k} should be a non-empty path`)
    }
})

test('linux: full lifecycle (create/start/listPids/kill/killAll/delete)', async (t) => {
    if (!isLinux) { t.skip('not linux'); return }
    if (isSandboxed) { t.skip('running inside a sandbox'); return }

    let mgr
    try {
        mgr = createSandbox()
    } catch (e) {
        t.skip('preflight failed: ' + e.message)
        return
    }

    mgr.deleteAll() // clean leftovers

    const id = `test${process.pid}`
    const box = mgr.create(id, {
        fileWhitelist: [],
        fileBlacklist: ['/etc/passwd'],
        network: false,
    })

    try {
        assert.equal(typeof box.getStoragePath(), 'string')
        assert.ok(box.getStoragePath().length > 0)

        const boxes = mgr.list()
        assert.ok(boxes.length >= 1)

        // start a long-lived process, observe it via listPids, then kill it
        const pid = await box.start(['sh', '-c', 'sleep 30'])
        assert.ok(pid > 0)

        let seen = false
        for (let i = 0; i < 5 && !seen; i++) {
            await sleep(1000)
            seen = box.listPids().includes(pid)
        }
        assert.ok(seen, 'spawned pid should appear in listPids()')

        const status = box.kill(pid)
        assert.equal(typeof status, 'boolean')

        box.killAll()
        await sleep(200)
        assert.ok(!box.listPids().includes(pid), 'pid should be gone after kill')

        t.diagnostic('full lifecycle OK')
    } finally {
        mgr.delete(id)
    }
    assert.ok(!mgr.list().some(b => b.section.endsWith(id)))
})
