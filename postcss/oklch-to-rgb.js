const plugin = (opts) => {
	return {
		postcssPlugin: "oklch-to-rgb",
		Declaration(decl) {
			if (decl.value.startsWith("oklch(")) {
				const match = /oklch\((\d*\.?\d*)\s+(\d*\.?\d*)\s+(\d*\.?\d*)\s*(?:\/\s*(\d*\.?\d*))?\)/.exec(decl.value);
				if (!match) {
					console.warn(decl.value);
					return;
				}

				let L = parseFloat(match[1]);
				let C = parseFloat(match[2]);
				let H = parseFloat(match[3]);
				let alpha = parseFloat(match[4]);
				if (isNaN(alpha)) alpha = 1;

				L = Math.max(0, Math.min(1, L));
				C = Math.max(0, C);
				H %= 360;
				if (H < 0) H += 360;

				const Lab = OKLCHToOKLab([L, C, H]);
				const xyz = OKLabToXYZ(Lab);

				// 尝试sRGB
				const sRGB = XYZTosRGB(xyz).map(v => parseInt(v*255));
				const inSRGB = sRGB.every(v => v >= 0 && v <= 255);
				if (inSRGB) {
					decl.value = "#"+sRGB.map(v => v.toString(16).padStart(2, "0")).join('');

					alpha = Math.round(alpha * 255);
					if (alpha < 0) alpha = 0;
					if (alpha > 255) alpha = 255;
					if (alpha !== 255) {
						decl.value += alpha.toString(16).padStart(2, "0");
					}
					return;
				}

				// 不在RGB范围中，尝试P3
				let p3 = XYZToP3(xyz);
				if (!p3.every(v => v >= 0 && v <= 1)) {
					function getDeltaE(c) {
						p3 = XYZToP3(OKLabToXYZ(OKLCHToOKLab([L, c, H]))).map(v => v < 0 ? 0 : v > 1 ? 1 : v);
						return DeltaEOK(P3ToXYZ(p3), xyz);
					}

					findMinimumInRange(getDeltaE, 0, C);
				}

				let outputValue = `color(display-p3 ${p3.map(v => v.toFixed(6)).join(' ')}`;
				if (alpha !== 1) outputValue += ` / ${alpha.toFixed(4)}`;
				decl.value = outputValue + ')';
			}
		}
	}
};
plugin.postcss = true;

export default plugin;


const RGBMatrix = [
	3.2409699419045226,  -1.537383177570094,  -0.4986107602930034,
	-0.9692436362808796,   1.8759675015077202,  0.04155505740717559,
	0.05563007969699366, -0.20397695888897652, 1.0569715142428786
];
const P3Matrix = [
	2.493496911941425,   -0.9313836179191239, -0.40271078445071684,
	-0.8294889695615747,  1.7626640603183463,  0.023624685841943577,
	0.03584583024378447, -0.07617238926804182, 0.9568845240076872
];
const invP3Matrix = MatInv(P3Matrix);

function SCurve(color) {
	const input = Math.abs(color);

	if (input > 0.0031308) {
		const number = (1.055 * (Math.pow(input, (1.0 / 2.4)))) - 0.055;
		return color >= 0 ? number : -number;
	}

	return color * 12.92;
}
function invSCurve(color) {
	const input = Math.abs(color);

	if (input > 0.04045) {
		const number = Math.pow((input + 0.055) / 1.055, 2.4);
		return color >= 0 ? number : -number;
	}

	return input / 12.92;
}

function XYZTosRGB(xyz) {
	return MatMul(RGBMatrix, xyz).map(SCurve);
}
function XYZToP3(xyz) {
	return MatMul(P3Matrix, xyz).map(SCurve);
}
function P3ToXYZ(color){
	return MatMul(invP3Matrix, color.map(invSCurve));
}

const OKLabM1 = [
	+0.8189330101, +0.3618667424, -0.1288597137,
	+0.0329845436, +0.9293118715, +0.0361456387,
	+0.0482003018, +0.2643662691, +0.6338517070
];
const OKLabM2 = [
	+0.2104542553, +0.7936177850, -0.0040720468,
	+1.9779984951, -2.4285922050, +0.4505937099,
	+0.0259040371, +0.7827717662, -0.8086757660
];
const InvOKLabM1 = MatInv(OKLabM1);
const InvOKLabM2 = MatInv(OKLabM2);

function XYZToOKLab(xyz) {
	const lms = MatMul(OKLabM1, xyz);
	const lms1 = lms.map(x => Math.pow(x, 1/3));
	return MatMul(OKLabM2, lms1);
}
function OKLabToXYZ(lab) {
	const lms = MatMul(InvOKLabM2, lab);
	const lms1 = lms.map(x => Math.pow(x, 3));
	return MatMul(InvOKLabM1, lms1);
}
function OKLabToOKLCH(Lab) {
	const [L, a, b] = Lab;

	const H = Math.atan2(b, a) * 180 / Math.PI;
	const C = Math.sqrt(a * a + b * b);

	return [L, C, H];
}
function OKLCHToOKLab(LCH) {
	const [L, C, H] = LCH;
	const a = C * Math.cos(H * Math.PI / 180);
	const b = C * Math.sin(H * Math.PI / 180);
	return [L, a, b];
}

function DeltaEOK(xyz1, xyz2) {
	let [L1, a1, b1] = XYZToOKLab(xyz1);
	let [L2, a2, b2] = XYZToOKLab(xyz2);
	let dL = L1 - L2;
	let da = a1 - a2;
	let db = b1 - b2;
	return Math.sqrt(dL ** 2 + da ** 2 + db ** 2);
}

// **三叉搜索（Ternary Search）**算法是一种高效的一维优化方法，通过不断缩小搜索区间来逼近最小值点。
function findMinimumInRange(f, min, max, epsilon = 1e-3, maxIterations = 50) {
	let a = min;
	let b = max;
	let iterations = 0;

	while (b - a > epsilon && iterations < maxIterations) {
		const m1 = a + (b - a) / 3;
		const m2 = a + 2 * (b - a) / 3;

		const f1 = f(m1);
		const f2 = f(m2);

		if (f1 < f2) {
			b = m2;
		} else {
			a = m1;
		}

		iterations++;
	}

	// 返回区间中点作为近似最小值点
	return (a + b) / 2;
}

function MatMul(mat3, vec3) {
	const [
		m00, m01, m02,
		m10, m11, m12,
		m20, m21, m22
	] = mat3;
	const [
		x, y, z
	] = vec3;

	const x1 = m00 * x + m01 * y + m02 * z;
	const y1 = m10 * x + m11 * y + m12 * z;
	const z1 = m20 * x + m21 * y + m22 * z;

	return [x1, y1, z1];
}
function MatInv(mat3) {
	const [
		m00, m01, m02,
		m10, m11, m12,
		m20, m21, m22
	] = mat3;

	// calculate inverse of upper 3x3 matrix
	let nm02 = (m01 *  m12 - m02 * m11);
	let nm12 = (m02 *  m10 - m00 * m12);
	let nm22 = (m00 *  m11 - m01 * m10);

	const det = (nm22 *  m22 + (nm12 * m21 + nm02 * m20));
	const idet = 1.0 / det;

	const nm00 = (m11 *  m22 - m21 * m12) * idet;
	const nm01 = (m21 *  m02 - m01 * m22) * idet;
	nm02 *= idet;
	const nm10 = (m20 *  m12 - m10 * m22) * idet;
	const nm11 = (m00 *  m22 - m20 * m02) * idet;
	nm12 *= idet;
	const nm20 = (m10 *  m21 - m20 * m11) * idet;
	const nm21 = (m20 *  m01 - m00 * m21) * idet;
	nm22 *= idet;

	return [
		nm00, nm01, nm02,
		nm10, nm11, nm12,
		nm20, nm21, nm22
	]
}