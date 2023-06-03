/* eslint-disable promise/prefer-await-to-callbacks */
import path from 'node:path';
import fs, { createReadStream, createWriteStream } from 'node:fs';
import Busboy from 'busboy';
import jetpack from 'fs-jetpack';
import { v4 as uuidv4 } from 'uuid';

import type { WriteStream } from 'node:fs';
import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

interface FileMetadata {
	[key: string]: string;
}

interface Options {
	destination: string;
	maxFileSize: number;
	maxChunkSize: number;
	allowedExtensions?: string[];
	blockedExtensions?: string[];
	debug?: boolean;
}

interface Result {
	isChunkedUpload: boolean;
	ready?: boolean;
	path?: string;
	metadata: Record<string, string>;
}

let DEBUG = false;

export const checkIfUuid = (headers: IncomingHttpHeaders) => {
	if (!headers['chibi-uuid']) return false;
	if (typeof headers['chibi-uuid'] !== 'string') throw new Error('chibi-uuid is not a string');
	if (headers['chibi-uuid'].length !== 36) throw new Error('chibi-uuid does not meet the length criteria');
	if (!/[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}/.test(headers['chibi-uuid']))
		throw new Error('chibi-uuid is not a valid uuid');
	return true;
};

export const checkHeaders = (headers: IncomingHttpHeaders) => {
	return (
		(headers['chibi-chunk-number'] &&
			headers['chibi-chunks-total'] &&
			/^\d+$/.test(headers['chibi-chunk-number'] as unknown as string) &&
			/^\d+$/.test(headers['chibi-chunks-total'] as unknown as string)) ||
		false
	);
};

const isBiggerThanMaxSize = (maxFileSize: number, maxChunkSize: number, totalChunks: number) => {
	return maxChunkSize * totalChunks > maxFileSize;
};

const joinChunks = async (finalFile: string, dirPath: string, totalChunks: number) => {
	if (DEBUG) console.log('[ChibiUploader] Attempting to join chunks');
	const writeStream = createWriteStream(finalFile);

	let chunkCount = 1;

	return new Promise((resolve, reject) => {
		const pipeChunk = async () => {
			try {
				if (DEBUG) console.log('[ChibiUploader] Chunk file:', path.join(dirPath, chunkCount.toString()));
				const readStream = createReadStream(path.join(dirPath, chunkCount.toString()));

				readStream.on('error', () => {
					reject(new Error('Error reading chunk'));
				});

				readStream.on('data', chunk => {
					if (!chunk) {
						reject(new Error('Chunk is null'));
					}

					writeStream.write(chunk);
				});

				readStream.on('end', async () => {
					chunkCount++;
					if (chunkCount <= totalChunks) {
						await pipeChunk();
					} else {
						writeStream.end();
						if (DEBUG) console.log('[ChibiUploader] All chunks joined, deleting temp folder', dirPath);
						await jetpack.removeAsync(dirPath);
						resolve({ path: finalFile });
					}
				});
			} catch (error: any) {
				console.error(error);
				return reject;
			}
		};

		void pipeChunk();
	});
};

const handleFile = (
	tmpDir: string,
	headers: IncomingHttpHeaders,
	fileStream: Readable,
	uuid: string,
	metadata: FileMetadata
) => {
	const filePath = path.join(tmpDir, `${uuid}${path.extname(metadata.name)}`);

	let error: Error;
	let writeStream: WriteStream;

	const writeFile = () => {
		writeStream = fs.createWriteStream(filePath);

		writeStream.on('error', err => {
			error = err;
			fileStream.resume();
		});

		writeStream.on('close', () => {
			// Finished uploading
		});

		fileStream.pipe(writeStream);
	};

	writeFile();

	return (callback: any) => {
		if (error) return callback(error);
		return callback(null, { path: filePath });
	};
};

const handleFileWithChunks = (
	tmpDir: string,
	headers: IncomingHttpHeaders,
	fileStream: Readable,
	metadata: FileMetadata
) => {
	const filePath = path.join(tmpDir, `${headers['chibi-uuid']}`);
	const dirPath = path.join(tmpDir, `${headers['chibi-uuid']}_tmp`);
	const chunkPath = path.join(dirPath, headers['chibi-chunk-number'] as string);
	const chunkCount = Number(headers['chibi-chunk-number']);
	const totalChunks = Number(headers['chibi-chunks-total']);

	let error: Error;
	let joined = false;
	let writeStream: WriteStream;

	const writeFile = () => {
		writeStream = fs.createWriteStream(chunkPath);

		writeStream.on('error', err => {
			error = err;
			fileStream.resume();
		});

		writeStream.on('close', async () => {
			// If all chunks were uploaded
			if (chunkCount === totalChunks) {
				joined = true;
				try {
					await joinChunks(`${filePath}${path.extname(metadata.name)}`, dirPath, totalChunks);
				} catch (error) {
					console.error(error);
				}
			}
		});

		fileStream.pipe(writeStream);
	};

	// Create destination directory
	jetpack.dir(dirPath);

	// make sure chunk is in range
	if (chunkCount < 0 || chunkCount > totalChunks) {
		error = new Error('Chunk is out of range');
		fileStream.resume();
	}

	writeFile();

	return (callback: any) => {
		if (error) return callback(error);
		writeStream.on('error', callback);
		writeStream.on('close', () => {
			if (joined) return callback(null, filePath);
			return callback(null, false);
		});
	};
};

export const processFile = async (req: IncomingMessage, options: Options) => {
	if (options.debug) {
		DEBUG = true;
	}

	// Make sure the destination folder exists
	await jetpack.dirAsync(options.destination);

	if (DEBUG) console.log('');
	if (DEBUG) console.log('[ChibiUploader] Received new file');
	if (DEBUG) console.log('[ChibiUploader] maxFileSize:', options.maxFileSize);
	if (DEBUG) console.log('[ChibiUploader] maxChunkSize:', options.maxChunkSize);

	return new Promise((resolve, reject) => {
		// Determine if we're using chunks or not
		// To use chunks user needs to supply chibi-uuid, chibi-chunk-number and chibi-chunks-total headers
		const usingChunks = checkIfUuid(req.headers);
		if (usingChunks && !checkHeaders(req.headers)) {
			// One of the 2 headers is missing or is not a number
			reject(new Error('Invalid headers'));
			return;
		}

		if (isBiggerThanMaxSize(options.maxFileSize, options.maxChunkSize, Number(req.headers['chibi-chunks-total']))) {
			reject(new Error('Chunked upload is above size limit'));
			return;
		}

		let uuid: string;
		if (usingChunks) {
			if (DEBUG) console.log('[ChibiUploader] Type: Chunked upload');
			if (DEBUG) console.log('[ChibiUploader] UUID:', req.headers['chibi-uuid'] as string);
			if (DEBUG)
				console.log(
					`[ChibiUploader] Chunk number: ${req.headers['chibi-chunk-number'] as string}/${
						req.headers['chibi-chunks-total'] as string
					}`
				);
		} else {
			uuid = uuidv4();
			if (DEBUG) console.log('[ChibiUploader] Type: Single file upload');
			if (DEBUG) console.log('[ChibiUploader] UUID:', uuid);
		}

		try {
			let fileStatus: Function;
			let reachedFileSizeLimit = false;
			const metadata: Record<string, string> = {};

			const busboy = Busboy({
				headers: req.headers,
				limits: {
					files: 1,
					// We add an extra 1024 bytes to the maxChunkSize to account for the metadata
					fileSize: options.maxChunkSize + 1024
				}
			});

			busboy.on('file', (fieldname, fileStream) => {
				// File name only appears on the last chunk
				if (DEBUG && metadata.name) console.log(`[ChibiUploader] Name:`, metadata.name);

				// Triggered when file is too big
				fileStream.on('limit', () => {
					reachedFileSizeLimit = true;
					fileStream.resume();
				});

				if (usingChunks) {
					// console.log('> Using Chunks');
					fileStatus = handleFileWithChunks(options.destination, req.headers, fileStream, metadata);
				} else {
					// console.log('> Not Using Chunks');
					fileStatus = handleFile(options.destination, req.headers, fileStream, uuid, metadata);
				}
			});

			busboy.on('field', (key, val) => {
				metadata[key] = val;
			});

			busboy.on('finish', async () => {
				if (reachedFileSizeLimit) {
					if (usingChunks) {
						// If one of the chunks is too big there's a config problem so we delete the tmp folder
						console.log('[ChibiUploader] Deleting chunk folder since one of the chunks is too big');
						await jetpack.removeAsync(path.join(options.destination, `${req.headers['chibi-uuid']}_tmp`));
						reject(new Error('Chunk is too big'));
					} else {
						// If the file is too big we delete it
						console.log('[ChibiUploader] Deleting file since it is too big');
						await jetpack.removeAsync(path.join(options.destination, uuid));
						reject(new Error('File is too big'));
					}

					return;
				}

				fileStatus?.((fileErr: Error, resultPromise: any) => {
					if (fileErr) {
						reject(fileErr);
						return;
					}

					if (DEBUG) console.log('[ChibiUploader] Done:', metadata.name);

					if (usingChunks) {
						let filePath;
						if (resultPromise) {
							filePath = `${resultPromise}${path.extname(metadata.name)}`;
							if (DEBUG) console.log('[ChibiUploader] Filename:', filePath);
						}

						resolve({
							isChunkedUpload: true,
							ready: Boolean(resultPromise),
							path: resultPromise ? filePath : undefined,
							metadata
						});
						return;
					}

					if (DEBUG) console.log('[ChibiUploader] Filename:', resultPromise.path);

					resolve({
						isChunkedUpload: false,
						path: resultPromise.path,
						metadata
					});
				});
			});

			req.pipe(busboy);
		} catch (error) {
			reject(error);
			console.log(error);
		}
	}) as Promise<Result>;
};

/*
	TODO:
		Check for file size on the header and delete the upload if it's too big
		Check for file size after upload and delete the upload if it's too big

		---
		When both the client and the server are set to 90MB as the chunk size limit,
		it seems the frontend is sending 90MB + few bytes, so the server rejects it.

		The problem with this is that if its a chunked upload, the first chunk is deleted
		but the following chunks are not, so the upload is left in a broken state.

		If uploading a file of 120mb, the first chunk is deleted and the next one which is
		only 30mb goes through smoothly. Need to think how to solve this.

		Error log:
		> Received new file
		> Type: Chunked upload
		> UUID: a3eea85b-c6bc-44ed-b61b-cd7f8dc42c2a
		> Chunk number: 1/2
		> Deleting chunk folder since one of the chunks is too big

		> Received new file
		> Type: Chunked upload
		> UUID: a3eea85b-c6bc-44ed-b61b-cd7f8dc42c2a
		> Chunk number: 2/2
		> Name: hkrpg_ua_f491148198cd.exe
		> Attempting to join chunks
		> Chunk location: tmp\a3eea85b-c6bc-44ed-b61b-cd7f8dc42c2a_tmp\1
		> Done: hkrpg_ua_f491148198cd.exe
		readStream error
		[Error: ENOENT: no such file or directory, open '.\tmp\a3eea85b-c6bc-44ed-b61b-cd7f8dc42c2a_tmp\1']
*/
