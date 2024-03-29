import { v4 as uuidv4 } from 'uuid';

export interface UploaderOptions {
	autoStart: boolean;
	endpoint: string;
	file: File;
	headers?: HeadersInit;
	postParams?: Record<string, string>;
	maxFileSize?: number;
	chunkSize?: number;
	retries?: number;
	delayBeforeRetry?: number;
	maxParallelUploads: number;
	allowedExtensions?: string[];
	blockedExtensions?: string[];
	debug: boolean;
	method: 'POST' | 'PUT';
	onStart?(uuid: string, totalChunks: number): void;
	onError?(uuid: string, error: Error): void;
	onProgress?(uuid: string, progress: number): void;
	onRetry?(uuid: string, obj: any): void;
	onFinish?(uuid: string, obj: any): void;
}

type Debug = (...args: any[]) => void;

let DEBUG = false;
let StopUploadsBecauseError = false;

let debug: Debug = () => {};

const validateOptions = (options: UploaderOptions) => {
	if (!options.endpoint?.length) throw new TypeError('endpoint must be defined');
	if (options.file instanceof File === false) throw new TypeError('file must be a File object');
	if (options.headers && typeof options.headers !== 'object')
		throw new TypeError('headers must be null or an object');
	if (options.postParams && typeof options.postParams !== 'object')
		throw new TypeError('postParams must be null or an object');
	if (options.chunkSize && (typeof options.chunkSize !== 'number' || options.chunkSize === 0))
		throw new TypeError('chunkSize must be a positive number');
	if (options.retries && (typeof options.retries !== 'number' || options.retries === 0))
		throw new TypeError('retries must be a positive number');
	if (options.delayBeforeRetry && typeof options.delayBeforeRetry !== 'number')
		throw new TypeError('delayBeforeRetry must be a positive number');
};

const validateSize = (file: File, maxFileSize: number) => {
	debug('File size:', file.size, 'maxFileSize:', maxFileSize);
	if (file.size > maxFileSize) throw new Error('File size is too big');
};

const validateFileExtension = (file: File, allowedExtensions?: string[], blockedExtensions?: string[]) => {
	if (allowedExtensions?.length) {
		const extension = file.name.split('.').pop();
		if (!extension) throw new Error('File extension could not be determined');
		if (!allowedExtensions.includes(extension)) throw new Error('File extension is not allowed');
	}

	if (blockedExtensions?.length) {
		const extension = file.name.split('.').pop();
		if (!extension) throw new Error('File extension could not be determined');
		if (blockedExtensions.includes(extension)) throw new Error('File extension is not allowed');
	}
};

export const chibiUploader = async (options: UploaderOptions) => {
	const {
		autoStart = true,
		endpoint,
		file,
		headers = {},
		postParams,
		maxFileSize = 1 * 1e9, // 1GB
		chunkSize = 9 * 9e7, // 90MB
		retries = 5,
		delayBeforeRetry = 3,
		maxParallelUploads = 3,
		allowedExtensions = [],
		blockedExtensions = [],
		method = 'POST'
	} = options;

	DEBUG = Boolean(options.debug);

	// Bind debug to the browser console if debug is enabled
	if (DEBUG) {
		debug = console.log.bind(
			window.console,
			'%c ChibiUploader ',
			'background:#355e5e; padding: 2px; border-radius: 2px; color: #fff'
		);
	}

	StopUploadsBecauseError = false;

	const uuid = uuidv4();
	const totalChunks = Math.ceil(file.size / chunkSize);
	debug('Chunk size:', chunkSize);
	debug('Total chunks:', totalChunks);

	options.onStart?.(uuid, totalChunks);

	try {
		validateOptions(options);
		validateFileExtension(options.file, allowedExtensions, blockedExtensions);
		validateSize(options.file, maxFileSize);
	} catch (error: any) {
		options.onError?.(uuid, error);
		return;
	}

	const uploader: {
		start: number;
		chunkIndex: number;
		totalChunks: number;
		retriesCount: number;
		offline: boolean;
		paused: boolean;
	} = {
		start: 0,
		chunkIndex: 0,
		totalChunks,
		retriesCount: 0,
		offline: false,
		paused: false
	};

	if (totalChunks > 1) {
		// @ts-expect-error: headers type
		headers['chibi-uuid'] = uuid;
		// @ts-expect-error: headers type
		headers['chibi-chunks-total'] = totalChunks;
	}

	const getChunks = () => {
		const chunks = [];
		for (let i = 0; i < totalChunks; i++) {
			const start = chunkSize * i;
			const end = start + chunkSize;
			const chunk = file.slice(start, end);
			chunks.push({
				index: i + 1,
				chunk
			});
		}

		return chunks;
	};

	const sendChunk = async (chunk: ArrayBuffer, index: number) => {
		const form = new FormData();

		// send post fields on last request
		if (index === uploader.totalChunks && postParams) {
			for (const key of Object.keys(postParams)) form.append(key, postParams[key]);
		}

		if (uploader.totalChunks === 1) {
			form.append('file', file);

			const xhr = new XMLHttpRequest();
			xhr.open(method, endpoint);

			// @ts-expect-error: headers type
			for (const key of Object.keys(headers)) xhr.setRequestHeader(key, headers[key]);

			xhr.upload.addEventListener('progress', (event: ProgressEvent) => {
				if (event.lengthComputable) {
					const percentProgress = ((event.loaded / event.total) * 100) | 0;
					options.onProgress?.(uuid, percentProgress);
				}
			});

			xhr.upload.addEventListener('error', (event: Event) => {
				try {
					const message = JSON.parse(xhr.response).message;
					options.onError?.(uuid, new Error(message));
				} catch {
					options.onError?.(uuid, new Error(xhr.response));
				}
			});

			xhr.onreadystatechange = () => {
				if (xhr.readyState === 4) {
					if ([200, 201, 204].includes(xhr.status)) {
						debug('Upload finished');
						try {
							if (method === 'POST') {
								const response = JSON.parse(xhr.response);
								options.onFinish?.(uuid, response);
							} else {
								options.onFinish?.(uuid, null);
							}
						} catch {
							options.onError?.(uuid, new Error('There was a problem parsing the JSON response'));
						}
					} else {
						try {
							const message = JSON.parse(xhr.response).message;
							options.onError?.(uuid, new Error(message));
						} catch {
							options.onError?.(uuid, new Error(xhr.response));
						}
					}
				}
			};

			xhr.send(method === 'PUT' ? file : form);
		} else {
			form.append('file', new Blob([chunk], { type: 'application/octet-stream' }));
			// @ts-expect-error: headers type
			headers['chibi-chunk-number'] = index;
			return fetch(endpoint, { method, headers, body: form });
		}
	};

	const manageRetries = (index: number) => {
		if (uploader.retriesCount++ < retries) {
			// eslint-disable-next-line @typescript-eslint/no-use-before-define
			globalThis.setTimeout(async () => sendChunks(), delayBeforeRetry * 1000);
			options.onRetry?.(uuid, {
				message: `An error occured uploading chunk ${index}. ${retries - uploader.retriesCount} retries left`,
				chunk: index,
				retriesLeft: retries - uploader.retriesCount
			});
			return;
		}

		options.onError?.(
			uuid,
			new Error(`An error occured uploading chunk ${index}. No more retries, stopping upload`)
		);
	};

	const actuallySendChunks = async (chunk: ArrayBuffer, index: number) => {
		if (StopUploadsBecauseError) {
			debug('Skipping because of an error');
			return;
		}

		try {
			const response = await sendChunk(chunk, index);
			debug('sendChunk response', response);
			if (!response) return;
			if (response.status === 200 || response.status === 201 || response.status === 204) {
				if (totalChunks > 1) {
					// Calculate the progress based on the filesize, the total amount of chunks and the chunk index
					const percentProgress = Math.round((100 / uploader.totalChunks) * index);
					options.onProgress?.(uuid, percentProgress);
					debug('Progress:', percentProgress, '%');

					// Last chunk has a JSON response with the URL
					if (uploader.totalChunks === index) {
						try {
							const apiResponse = await response.json();
							if (apiResponse.url) {
								options.onFinish?.(uuid, apiResponse);
							} else {
								options.onError?.(uuid, new Error('No URL returned by the server'));
							}
						} catch (error) {
							console.log(error);
							options.onError?.(uuid, new Error('There was a problem parsing the JSON response'));
						}
					}
				}
			} else if ([408, 502, 503, 504].includes(response.status)) {
				if (uploader.paused || uploader.offline) return;
				debug('Received response:', response.status);
				manageRetries(index);
			} else if (response.status === 413) {
				options.onError?.(uuid, new Error(`Chunks are too big. Stopping upload`));
				// eslint-disable-next-line require-atomic-updates
				StopUploadsBecauseError = true;
			} else {
				if (uploader.paused || uploader.offline) return;
				options.onError?.(uuid, new Error(`Server responded with ${response.status}. Stopping upload`));
			}
		} catch (error: any) {
			if (uploader.paused || uploader.offline) return;
			console.log(error);
			manageRetries(index);
		}
	};

	const sendChunks = async () => {
		if (uploader.paused || uploader.offline) return;

		const chunks = getChunks();
		const slices = chunks.slice(0, uploader.totalChunks - 1);
		const lastChunk = chunks.at(-1);

		const slicesChunks = slices.reduce<{ index: number; chunk: Blob }[][]>((acc, _, i) => {
			if (i % maxParallelUploads === 0) acc.push(slices.slice(i, i + maxParallelUploads));
			return acc;
		}, []);

		for (const sliceChunks of slicesChunks) {
			await Promise.allSettled(
				sliceChunks.map(async chunk => {
					return actuallySendChunks(await chunk.chunk.arrayBuffer(), chunk.index);
				})
			);
		}

		// Send last chunk
		await actuallySendChunks(await lastChunk!.chunk.arrayBuffer(), uploader.totalChunks);

		// If it's just one chunk the response will be handled by the XHR request
		if (totalChunks === 1) return;

		// Otherwise send the response
		debug('Upload finished');
	};

	const togglePause = async () => {
		uploader.paused = !uploader.paused;
		if (!uploader.paused) await sendChunks();
	};

	if (autoStart) await sendChunks();

	const start = async () => sendChunks();

	return {
		togglePause,
		start
	};
};
