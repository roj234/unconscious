import assert from 'node:assert'
import {Router} from '../router.js'

const hit = (r, m, u) => r.find(m, u)
/** 只比较显式属性（Params 的自有属性），顺带验证 {...params} 能正常展开 */
const own = (p) => ({ ...p })

// ---------------------------------------------------------------- 基础
{
	const r = new Router()
	const h = () => {}
	r.add('GET', '/', h)
	r.add('GET', '/user/:id', h)
	// 同一路径不能既挂 /user/:id 又挂 /user/:id/（同 Java 的 node.flag != flag）
	assert.throws(() => r.add('GET', '/user/:id/', h), /重复注册|尾斜杠定义不一致/)
	r.add('GET', '/u/:id(\\d+)', h)
	r.add('GET', '/:lang(en|zh)/index', h)
	r.add('POST', '/only-post', h)

	assert.deepStrictEqual(own(hit(r, 'GET', '/').params), {})
	assert.deepStrictEqual(own(hit(r, 'GET', '/user/42').params), { id: '42' })
	assert.deepStrictEqual(own(hit(r, 'GET', '/user/a%20b').params), { id: 'a b' })
	// 严格尾斜杠
	assert.strictEqual(hit(r, 'GET', '/user'), null)
	// 正则约束
	assert.deepStrictEqual(own(hit(r, 'GET', '/u/12').params), { id: '12' })
	assert.strictEqual(hit(r, 'GET', '/u/ab'), null)
	assert.deepStrictEqual(own(hit(r, 'GET', '/en/index').params), { lang: 'en' })
	assert.strictEqual(hit(r, 'GET', '/fr/index'), null)
	// method
	assert.ok(r.find('get', '/').handler)                 // 大小写不敏感
	assert.deepStrictEqual(hit(r, 'DELETE', '/only-post').allow, ['POST'])
	assert.ok(r.find('HEAD', '/user/1').handler)          // HEAD 回落 GET
	assert.strictEqual(hit(r, 'GET', '/nope/x'), null)

	// 尾斜杠路由只匹配尾斜杠
	const dir = new Router()
	dir.add('GET', '/only/', h)
	assert.ok(dir.find('GET', '/only/').handler)
	assert.strictEqual(dir.find('GET', '/only'), null)
}

// ---------------------------------------------------------------- params 形状（第一个值 + getAll）
{
	const r = new Router()
	r.add('GET', '/user/:id', () => {})
	r.add('GET', '/api/:rest*', () => {})
	r.add('GET', '/deep/:path+', () => {})
	r.add('GET', '/list/:page?', () => {})

	// 单段：属性和 getAll 一致
	let p = hit(r, 'GET', '/user/42').params
	assert.strictEqual(p.id, '42')
	assert.deepStrictEqual(p.getAll('id'), ['42'])
	assert.deepStrictEqual(own(p), { id: '42' })

	// 多段：属性是第一个值，getAll 是逐段
	p = hit(r, 'GET', '/api/a/b/c').params
	assert.strictEqual(p.rest, 'a')
	assert.deepStrictEqual(p.getAll('rest'), ['a', 'b', 'c'])
	assert.strictEqual(p.getAll('rest').join('/'), 'a/b/c') // 要整串就自己 join
	assert.deepStrictEqual(own(p), { rest: 'a' })
	assert.deepStrictEqual(p.getAll('nope'), [])

	// 段内的 %2F 不会被当成分隔符（整串 join 会歧义，数组不会）
	assert.deepStrictEqual(hit(r, 'GET', '/api/a%2Fb/c').params.getAll('rest'), ['a/b', 'c'])
	assert.deepStrictEqual(own(hit(r, 'GET', '/api/a%2Fb/c').params), { rest: 'a/b' })

	// 解构、JSON、展开都正常；getAll 不可枚举
	assert.deepStrictEqual(((o) => { const { id } = o; return { id } })(hit(r, 'GET', '/user/7').params), { id: '7' })
	assert.strictEqual(JSON.stringify(hit(r, 'GET', '/user/7').params), '{"id":"7"}')
	assert.strictEqual(Object.keys(hit(r, 'GET', '/user/7').params).join(), 'id')
	assert.ok(!('getAll' in own(hit(r, 'GET', '/user/7').params)))
	// 没有参数的路由也拿得到 getAll
	assert.deepStrictEqual(hit(r, 'GET', '/list').params.getAll('page'), [])

	// 可选段未命中 → 属性不存在（undefined）
	assert.strictEqual(hit(r, 'GET', '/list').params.page, undefined)
	assert.strictEqual(hit(r, 'GET', '/list/2').params.page, '2')

	// 名字叫 constructor / __proto__ 也不会污染
	const weird = new Router()
	weird.add('GET', '/w/:constructor/:__proto__', () => {})
	const wp = hit(weird, 'GET', '/w/a/b').params
	assert.strictEqual(wp.constructor, 'a')
	assert.strictEqual(Object.getPrototypeOf(wp) !== Object.prototype, true)
	assert.deepStrictEqual(wp.getAll('__proto__'), ['b'])
}

// ---------------------------------------------------------------- 末尾零宽
{
	const r = new Router()
	const h = () => {}
	r.add('GET', '/list/:page?', h)
	r.add('GET', '/file/:path*', h)
	r.add('GET', '/deep/:path+', h)
	r.add('GET', '/', h)

	assert.deepStrictEqual(own(hit(r, 'GET', '/list').params), {})
	assert.deepStrictEqual(own(hit(r, 'GET', '/list/2').params), { page: '2' })
	assert.deepStrictEqual(own(hit(r, 'GET', '/file').params), {})
	assert.deepStrictEqual(hit(r, 'GET', '/file/a/b/c').params.getAll('path'), ['a', 'b', 'c'])
	assert.strictEqual(hit(r, 'GET', '/file/'), null)     // 尾斜杠是另一条路径
	assert.strictEqual(hit(r, 'GET', '/deep'), null)
	assert.deepStrictEqual(hit(r, 'GET', '/deep/a/b').params.getAll('path'), ['a', 'b'])
}

// ---------------------------------------------------------------- 中间段零宽：只有带正则才允许
{
	// 不带正则 → 注册期抛异常
	assert.throws(() => new Router().add('GET', '/:a?/b', () => {}), /零宽转移/)
	assert.throws(() => new Router().add('GET', '/:a*/b', () => {}), /零宽转移/)
	// 复用已有节点也算中间段
	const r0 = new Router()
	r0.add('GET', '/a/:x?', () => {})
	assert.throws(() => r0.add('GET', '/a/:x?/b', () => {}), /零宽转移/)

	// 带正则 → 确定性跳过：匹配就吃掉，不匹配就让给后面
	const r = new Router()
	const h = () => {}
	r.add('GET', '/:a(\\d+)?/new', h)

	assert.deepStrictEqual(own(hit(r, 'GET', '/12/new').params), { a: '12' }) // 数字段 → 被 :a 吃掉
	assert.deepStrictEqual(own(hit(r, 'GET', '/new').params), {})             // 非数字 → 跳过 :a
	assert.strictEqual(hit(r, 'GET', '/ab/new'), null)
}

// ---------------------------------------------------------------- 优先级 (Route.java 第 45 行)
{
	const r = new Router()
	const mark = (n) => () => n
	r.add('GET', '/a/:x(\\d+)', mark('regex'))
	r.add('GET', '/a/:y', mark('plain'))
	r.add('GET', '/a/lit', mark('lit'))
	assert.strictEqual(r.find('GET', '/a/12').handler(), 'regex')  // 正则 > 无约束
	assert.strictEqual(r.find('GET', '/a/ab').handler(), 'plain')
	assert.strictEqual(r.find('GET', '/a/lit').handler(), 'lit')   // 精确 > 全部

	r.add('GET', '/b/:x?', mark('opt'))
	r.add('GET', '/b/:y', mark('plain'))
	assert.strictEqual(r.find('GET', '/b/v').handler(), 'plain')   // 无约束 > ?

	r.add('GET', '/c/:x+', mark('plus'))
	r.add('GET', '/c/:y*', mark('star'))
	assert.strictEqual(r.find('GET', '/c/v').handler(), 'plus')    // + > *

	r.add('GET', '/d/:z', mark('plain2'))
	r.add('GET', '/d/:rest*', mark('rest'))
	assert.strictEqual(r.find('GET', '/d/v').handler(), 'plain2')  // 无约束 > *
	assert.strictEqual(r.find('GET', '/d/v/w').handler(), 'rest')
}

// ---------------------------------------------------------------- 注册
{
	const r = new Router()
	r.add('GET', 'noslash/x', () => {})                  // 开头有无 '/' 等价
	assert.ok(r.find('GET', '/noslash/x').handler)
	assert.throws(() => r.add('GET', '/noslash/x', () => {}), /路由已注册/)
	assert.throws(() => r.add('GET', '/bad/:', () => {}), /无法解析/)

	// 深路径
	const deep = '/' + Array.from({ length: 60 }, (_, i) => 'p' + i).join('/')
	const route = '/' + Array.from({ length: 60 }, (_, i) => ':a' + i).join('/')
	r.add('GET', route, () => {})
	assert.strictEqual(r.find('GET', deep).params.a59, 'p59')
}

// ---------------------------------------------------------------- 宽松尾斜杠 (Route.java 第 51 行)
{
	const loose = new Router({ strict: false })
	const h = () => {}
	loose.add('GET', '/user', h)
	loose.add('GET', '/a/:id', h)
	loose.add('POST', '/user', h)

	assert.deepStrictEqual(own(hit(loose, 'GET', '/user').params), {})
	assert.deepStrictEqual(own(hit(loose, 'GET', '/user/').params), {})
	assert.deepStrictEqual(own(hit(loose, 'GET', '/a/7').params), { id: '7' })
	assert.deepStrictEqual(own(hit(loose, 'GET', '/a/7/').params), { id: '7' })
	// 405 也能跨两种写法汇总
	assert.deepStrictEqual(hit(loose, 'DELETE', '/user/').allow, ['GET', 'POST'])

	// 单条覆盖
	const mixed = new Router()
	mixed.add('GET', '/strict', h)
	mixed.add('GET', '/loose', h, { strict: false })
	assert.strictEqual(hit(mixed, 'GET', '/strict/'), null)
	assert.ok(hit(mixed, 'GET', '/loose/').handler)

	// 严格模式默认：'/a' 不匹配 '/a/'
	const strict = new Router()
	strict.add('GET', '/a', h)
	assert.strictEqual(hit(strict, 'GET', '/a/'), null)

	// 宽松 + 尾段可选
	const opt = new Router({ strict: false })
	opt.add('GET', '/list/:page?', h)
	assert.deepStrictEqual(own(hit(opt, 'GET', '/list').params), {})
	assert.deepStrictEqual(own(hit(opt, 'GET', '/list/2').params), { page: '2' })
	assert.deepStrictEqual(own(hit(opt, 'GET', '/list/2/').params), { page: '2' })
	assert.deepStrictEqual(own(hit(opt, 'GET', '/list/').params), {})

	// 同一路径不能混用不同的尾斜杠定义（Java 的 node.flag != flag）
	const mixedStrict = new Router()
	mixedStrict.add('GET', '/same', h)
	assert.throws(() => mixedStrict.add('POST', '/same', h, { strict: false }), /尾斜杠定义不一致/)
	assert.throws(() => mixedStrict.add('POST', '/same/', h, { strict: false }), /尾斜杠定义不一致|重复注册/)
}
