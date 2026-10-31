// host.test.js - sadbox host verification
//
// Must run on a REAL host (non-sandboxed) machine.
// In a sandboxed process the config-write operations are rejected by SbieSvc (STATUS_NOT_SUPPORTED)
import test from 'node:test'
import assert from 'node:assert/strict'
import {createSandbox, getVersion, isSandboxed} from '../src/sadbox.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

test('module loads and reports version', (t) => {
    if (process.platform !== 'win32') { t.skip('windows only'); return }
    assert.equal(typeof getVersion(), 'string')
    assert.ok(getVersion().length > 0)
    console.log('  version:', getVersion(), '| isSandboxed:', isSandboxed)
})

test('create + list + getStoragePath + delete (host only)', async (t) => {
    if (process.platform !== 'win32') { t.skip('windows only'); return }
    if (isSandboxed) {
        t.skip('sandboxed caller: create/delete are rejected by SbieSvc')
        return
    }

    const mgr = createSandbox();
    mgr.deleteAll() // clean leftovers

    const id = `test${String(process.pid)}`
    const store = process.env.SBIE_TEST_STORE || 'C:/sadbox-test'
    const box = mgr.create(id, {
        fileWhitelist: ['C:/Users/Public/Documents'],
        fileBlacklist: ['C:/Windows/System32/drivers/etc/hosts'],
        network: false,
        storagePath: store,
    })

    // storagePath is used verbatim as the sandbox root (separator-insensitive)
    const norm = s => s.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '')
    assert.equal(norm(box.getStoragePath()), norm(store))

    const boxes = mgr.list()
    assert.ok(boxes.length >= 1)

    // start a long-lived process, observe it via listPids, then kill it
    const pid = box.start(['cmd.exe', '/c', 'ping -n 20 127.0.0.1'])
    assert.ok(pid > 0)

    let seen = false
    for (let i = 0; i < 5 && !seen; i++) {
        await sleep(1000)
        seen = box.listPids().includes(pid)
    }
    assert.ok(seen, 'spawned pid should appear in listPids()')

    const status = box.kill(pid)
    assert.ok(typeof status === 'boolean')

    box.killAll()
    mgr.delete(id)
    assert.ok(!mgr.list().some(b => norm(b.getStoragePath()) === norm(store)))

    t.diagnostic('full lifecycle OK')
})
