import {createSign, generateKeyPairSync} from 'node:crypto';

// 只用于测试的极简 DER 编码器 + 自签名 RSA 证书生成。
// 本机没有 openssl，所以这里手写 X.509 v3 的 TBSCertificate。

const tlv = (tag, body) => {
	const len = body.length;
	let header;
	if (len < 0x80) header = Buffer.from([tag, len]);
	else if (len < 0x100) header = Buffer.from([tag, 0x81, len]);
	else header = Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
	return Buffer.concat([header, body]);
};
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const int = bytes => tlv(0x02, Buffer.from(bytes));
const nullValue = () => Buffer.from([0x05, 0x00]);
const oid = bytes => tlv(0x06, Buffer.from(bytes));
const bitString = body => tlv(0x03, Buffer.concat([Buffer.from([0x00]), body]));

const OID_CN = [0x55, 0x04, 0x03];
const OID_SHA256_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];

const name = cn => seq(set(seq(oid(OID_CN), tlv(0x0c, Buffer.from(cn, 'utf8')))));
const utcTime = s => tlv(0x17, Buffer.from(s, 'ascii'));

/**
 * 生成仅用于测试的自签名证书。
 * @param {string} [cn]
 * @returns {{key: string, cert: string}}
 */
export function selfSignedCert(cn = 'localhost') {
	const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
	const sigAlg = seq(oid(OID_SHA256_RSA), nullValue());
	const spki = publicKey.export({type: 'spki', format: 'der'});
	const tbs = seq(
		tlv(0xa0, int([2])),
		int([1]),
		sigAlg,
		name(cn),
		seq(utcTime('250101000000Z'), utcTime('350101000000Z')),
		name(cn),
		spki,
	);
	const signature = createSign('sha256').update(tbs).sign(privateKey);
	const cert = seq(tbs, sigAlg, bitString(signature));
	return {
		key: privateKey.export({type: 'pkcs8', format: 'pem'}),
		cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`,
	};
}
