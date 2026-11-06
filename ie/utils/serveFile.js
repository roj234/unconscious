import {pipeline} from "node:stream/promises";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";

const NOT_EXIST_STAT = {isDirectory: () => false, isFile: () => false, size: 0, notExist: true};

/**
 * @param {string} file
 * @return {Promise<import("node:fs").Stats & { notExist?: boolean }>}
 */
export const safeStat = file => stat(file).catch((error) => ({ ...NOT_EXIST_STAT, error }));

/**
 *
 * @param {{ req, res, searchParams?: URLSearchParams }} ctx
 * @param {{ name?: string, type?: string, lastModified: number, size: number, volatile: boolean }} info
 * @param {string} filePath
 * @return {Promise<void>}
 */
export const serveFile = async (ctx, info, filePath) => {
	const lastModified = new Date(info.lastModified).toUTCString();

	const ifModifiedSince = ctx.req.headers['if-modified-since'];
	if (ifModifiedSince) {
		const imsDate = new Date(ifModifiedSince);
		if (!isNaN(imsDate.getTime()) && Math.floor(info.lastModified/1000) <= imsDate.getTime()/1000) {
			ctx.res.writeHead(304, {
				'Content-Length': 0,
				'Last-Modified': lastModified,
			});
			ctx.res.end();
			return;
		}
	}

	const fileSize = info.size;
	const fileType = info.type || "application/octet-stream";
	const cacheControl = info.volatile ? 'public, no-cache, max-age=3600' : 'public, max-age=31536000, immutable';

	// 检查并解析 Range 头
	let range = ctx.req.headers['range'];
	let start, end;

	if (range && !range.includes(',')) {
		const ifRange = ctx.req.headers['if-range'];
		if (ifRange) {
			if (ifRange !== lastModified) range = null;
		}
	} else {
		range = null;
	}

	if (range) {
		const match = range.match(/^bytes=(\d+)-(\d*)$/);
		if (match) {
			start = parseInt(match[1], 10);
			if (match[2] !== '') {
				end = parseInt(match[2], 10);
			} else {
				end = fileSize - 1;
			}
		}

		if (!match || start < 0 || start >= fileSize || end >= fileSize || start > end) {
			ctx.res.writeHead(416, {
				'Content-Range': `bytes */${fileSize}`,
				'Content-Length': '0',
				'Last-Modified': lastModified
			});
			ctx.res.end();
			return;
		}

		const contentLength = end - start + 1;
		ctx.res.writeHead(206, {
			'Content-Range': `bytes ${start}-${end}/${fileSize}`,
			'Content-Length': contentLength.toString(),
			'Content-Type': fileType,
			'Cache-Control': cacheControl,
			'Last-Modified': lastModified,
			'Accept-Ranges': 'bytes'
		});

		// 管道部分内容
		return pipeline(createReadStream(filePath, { start, end }), ctx.res);
	}

	const name = ctx.searchParams?.get("name") || info.name;
	const headers = {
		'Content-Type': fileType,
		'Content-Length': fileSize,
		'Cache-Control': cacheControl,
		'Last-Modified': lastModified,
		'Accept-Ranges': 'bytes'
	};

	if (name) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(name)}"`;

	ctx.res.writeHead(200, headers);

	return pipeline(createReadStream(filePath), ctx.res);
}
