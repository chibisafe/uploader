export interface UploaderOptions {
	autoStart: boolean;
	endpoint: string;
	file: File;
	headers?: HeadersInit;
	postParams?: Record<string, string>;
	chunkSize?: number;
	retries?: number;
	delayBeforeRetry?: number;
	maxParallelUploads: number;
	allowedExtensions?: string[];
	blockedExtensions?: string[];
	debug: boolean;
	onStart?(uuid: string, totalChunks: number): void;
	onError?(uuid: string, error: Error): void;
	onProgress?(uuid: string, progress: number): void;
	onRetry?(uuid: string, obj: any): void;
	onFinish?(uuid: string, obj: any): void;
}

let DEBUG = false;
let StopUploadsBecauseError = false;

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
		chunkSize = 90,
		retries = 5,
		delayBeforeRetry = 3,
		maxParallelUploads = 3,
		allowedExtensions = [],
		blockedExtensions = []
	} = options;

	DEBUG = Boolean(options.debug);
	StopUploadsBecauseError = false;

	validateOptions(options);
	validateFileExtension(options.file, allowedExtensions, blockedExtensions);

	const totalChunks = Math.ceil(file.size / (chunkSize * 1000 * 1000));
	const uuid = globalThis.crypto.randomUUID();

	options.onStart?.(uuid, totalChunks);

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
			const start = chunkSize * 1000 * 1000 * i;
			const end = start + chunkSize * 1000 * 1000;
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
			xhr.open('POST', endpoint);

			// @ts-expect-error: headers type
			for (const key of Object.keys(headers)) xhr.setRequestHeader(key, headers[key]);

			xhr.upload.addEventListener('progress', (event: ProgressEvent) => {
				if (event.lengthComputable) {
					const percentProgress = ((event.loaded / event.total) * 100) | 0;
					options.onProgress?.(uuid, percentProgress);
				}
			});

			xhr.upload.addEventListener('error', (event: Event) => {
				options.onError?.(uuid, new Error(xhr.response));
			});

			xhr.onreadystatechange = () => {
				if (xhr.readyState === 4) {
					if ([200, 201, 204].includes(xhr.status)) {
						if (DEBUG) console.log('[ChibiUploader] Upload finished');
						try {
							const response = JSON.parse(xhr.response);
							options.onFinish?.(uuid, response);
						} catch {
							options.onError?.(uuid, new Error('There was a problem parsing the JSON response'));
						}
					} else {
						options.onError?.(uuid, new Error(xhr.response));
					}
				}
			};

			xhr.send(form);
		} else {
			form.append('file', new Blob([chunk], { type: 'application/octet-stream' }));
			// @ts-expect-error: headers type
			headers['chibi-chunk-number'] = index;
			return fetch(endpoint, { method: 'POST', headers, body: form });
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
			if (DEBUG) console.log('[ChibiUploader] Skipping because of an error');
			return;
		}

		try {
			const response = await sendChunk(chunk, index);
			if (DEBUG) console.log('[ChibiUploader] sendChunk response', response);
			if (!response) return;
			if (response.status === 200 || response.status === 201 || response.status === 204) {
				if (totalChunks > 1) {
					// Calculate the progress based on the filesize, the total amount of chunks and the chunk index
					const percentProgress = Math.round((100 / uploader.totalChunks) * index);
					options.onProgress?.(uuid, percentProgress);
					if (DEBUG) console.log('[ChibiUploader] Progress:', percentProgress, '%');

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
				if (DEBUG) console.log('[ChibiUploader] Received response:', response.status);
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
		if (DEBUG) console.log('[ChibiUploader] Upload finished');
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
