/* eslint-disable promise/prefer-await-to-callbacks */
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import type { FileInfo } from 'busboy';
import Busboy from 'busboy';
import jetpack from 'fs-jetpack';
import { v4 as uuidv4 } from 'uuid';
import Buffer from 'node:buffer';
import { Readable, Writable } from 'node:stream';

import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';

interface Options {
	destination: string;
	maxFileSize: number;
	maxChunkSize: number;
	allowedExtensions?: string[];
	blockedExtensions?: string[];
	debug?: boolean;
}

interface FileMetadata {
	[key: string]: string;
}

interface Result {
	isChunkedUpload: boolean;
	ready?: boolean;
	path?: string;
	metadata: FileMetadata;
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

const isAllowedExtension = (allowedExtensions: string[], extension: string) => {
	return allowedExtensions.includes(extension);
};

const isBlockedExtension = (blockedExtensions: string[], extension: string) => {
	return blockedExtensions.includes(extension);
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

	const upload = (await processBusboy(req, options)) as Result;
	if (DEBUG) console.log('[ChibiUploader] Finished uploading file:', upload);

	// Calculate the file size to pass back to the client
	const inspect = await jetpack.inspectAsync(upload.path as string);
	upload.metadata.size = inspect?.size as unknown as string;

	return upload;
};

export const processBusboy = async (req: IncomingMessage, options: Options) => {
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
			let reachedFileSizeLimit = false;
			const metadata: Record<string, string> = {};
			let busboyMetadata: FileInfo;

			const busboy = Busboy({
				headers: req.headers,
				limits: {
					files: 1,
					// We add an extra 1024 bytes to the maxChunkSize to account for the metadata
					fileSize: options.maxChunkSize + 1024
				}
			});

			let busboyFileBuffer: Buffer;

			busboy.on('file', (name, file, info) => {
				// File name only appears on the last chunk
				if (DEBUG && metadata.name) console.log(`[ChibiUploader] Name:`, metadata.name);
				busboyMetadata = info;

				// Save the file type from the mimeType returned by busboy
				metadata.type = busboyMetadata.mimeType;

				if (DEBUG)
					console.log(
						`[ChibiUploader] File [${name}]: filename: %j, encoding: %j, mimeType: %j`,
						info.filename,
						info.encoding,
						info.mimeType
					);

				const chunks: Buffer[] = [];
				const writable = new Writable({
					write(chunk: any, encoding: any, callback: any) {
						chunks.push(chunk);
						callback();
					}
				});

				file.pipe(writable);

				file.on('close', () => {
					busboyFileBuffer = Buffer.Buffer.concat(chunks);
					if (DEBUG) console.log('[ChibiUploader] File closed');
				});

				// Triggered when file is too big
				file.on('limit', () => {
					reachedFileSizeLimit = true;
					file.resume();
				});
			});

			busboy.on('field', (key, val) => {
				console.log('[ChibiUploader] Received metadata field:', key, val);
				metadata[key] = val;
			});

			busboy.on('close', async () => {
				if (DEBUG) console.log('[ChibiUploader] Busboy closed');

				const busboyFileStream = bufferToStream(busboyFileBuffer);

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

				if (usingChunks) {
					const upload = await handleFileWithChunks({
						destination: options.destination,
						headers: req.headers,
						fileStream: busboyFileStream,
						metadata
					});

					if (DEBUG) console.log('[ChibiUploader] Chunked upload finished', upload);

					if (upload.finished) {
						const stitchedUpload = await joinChunks({
							finalFilePath: upload.finalFilePath,
							dirPath: upload.dirPath,
							totalChunks: upload.totalChunks
						});

						// @ts-expect-error not sure what the error is here
						resolve({ ...stitchedUpload, metadata });
					} else {
						resolve({
							isChunkedUpload: true,
							ready: false
						});
					}
				} else {
					// If it's a single file upload we set the name to the filename returned by busboy
					metadata.name = busboyMetadata.filename;

					const upload = await handleSingleFile({
						options,
						destination: options.destination,
						fileStream: busboyFileStream,
						uuid,
						metadata
					});
					resolve({ ...upload, metadata });
				}
			});
			req.pipe(busboy);
		} catch (error) {
			reject(error);
			console.log(error);
		}
	});
};

const handleSingleFile = async ({
	options,
	destination,
	fileStream,
	uuid,
	metadata
}: {
	options: Options;
	destination: string;
	fileStream: Readable;
	uuid: string;
	metadata: Record<string, string>;
}) => {
	console.log('[ChibiUploader] Handling single file upload');
	const extension = path.extname(metadata.name);

	if (isBlockedExtension(options.blockedExtensions ?? [], extension)) {
		await jetpack.removeAsync(path.join(destination, uuid));
		throw new Error('File extension is blocked');
	}

	const filePath = path.join(destination, `${uuid}${path.extname(metadata.name)}`);
	return new Promise<Record<string, any>>((resolve, reject) => {
		const writeStream = createWriteStream(filePath);

		writeStream.on('error', err => {
			fileStream.resume();
			reject(err);
		});

		writeStream.on('close', () => {
			// Finished uploading
			console.log('[ChibiUploader] Finished uploading handleSingleFile');
			resolve({
				isChunkedUpload: false,
				ready: true,
				path: filePath
			});
		});

		fileStream.pipe(writeStream);
	});
};

const handleFileWithChunks = async ({
	destination,
	headers,
	fileStream,
	metadata
}: {
	destination: string;
	headers: IncomingHttpHeaders;
	fileStream: Readable;
	metadata: Record<string, string>;
}) => {
	console.log('[ChibiUploader] Handling chunked upload');
	const filePath = path.join(destination, `${headers['chibi-uuid']}`);
	const dirPath = path.join(destination, `${headers['chibi-uuid']}_tmp`);
	const chunkPath = path.join(dirPath, headers['chibi-chunk-number'] as string);
	const chunkCount = Number(headers['chibi-chunk-number']);
	const totalChunks = Number(headers['chibi-chunks-total']);

	// Create destination directory
	jetpack.dir(dirPath);

	return new Promise<Record<string, any>>((resolve, reject) => {
		const writeStream = createWriteStream(chunkPath);

		// make sure chunk is in range
		if (chunkCount < 0 || chunkCount > totalChunks) {
			reject(new Error('Chunk is out of range'));
			fileStream.resume();
		}

		writeStream.on('error', err => {
			reject(err);
			fileStream.resume();
		});

		writeStream.on('close', async () => {
			if (DEBUG) console.log('[ChibiUploader] Chunk file closed');
			// If all chunks were uploaded
			if (chunkCount === totalChunks) {
				if (DEBUG) console.log('[ChibiUploader] All chunks uploaded');
				resolve({
					finalFilePath: `${filePath}${path.extname(metadata.name)}`,
					dirPath,
					totalChunks,
					finished: true
				});
			}

			resolve({
				finished: false
			});
		});

		fileStream.pipe(writeStream);
	});
};

const joinChunks = async ({
	finalFilePath,
	dirPath,
	totalChunks
}: {
	finalFilePath: string;
	dirPath: string;
	totalChunks: number;
}) => {
	if (DEBUG) console.log('[ChibiUploader] Attempting to join chunks');

	let chunkCount = 1;
	return new Promise((resolve, reject) => {
		const writeStream = createWriteStream(finalFilePath);
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
						resolve({
							isChunkedUpload: true,
							ready: false,
							path: finalFilePath
						});
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

const bufferToStream = (binary: Buffer) => {
	return new Readable({
		read() {
			this.push(binary);
			this.push(null);
		}
	});
};
