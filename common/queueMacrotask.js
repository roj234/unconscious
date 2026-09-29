
let posted;
const ch = new MessageChannel();
ch.port1.onmessage = () => {
	const tmp = posted;
	posted = null;
	if (Array.isArray(tmp)) {
		for (const fn of tmp) {
			try {
				fn();
			} catch (e) {
				console.error(e);
			}
		}
	}
};
export const queueMacrotask = (callback) => {
	if (!posted) {
		posted = [];
		ch.port2.postMessage(0);
	}
	posted.push(callback);
}