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
	onStart?(uuid: string, totalChunks: number): void;
	onError?(uuid: string, error: Error): void;
	onProgress?(uuid: string, progress: number): void;
	onRetry?(uuid: string, obj: any): void;
	onFinish?(uuid: string, obj: any): void;
}

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
		maxParallelUploads = 3
	} = options;

	validateOptions(options);

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
			xhr.upload.addEventListener('load', (event: Event) => {
				console.log('[ChibiUploader] Upload finished');
				options.onFinish?.(uuid, { response: xhr.response });
				return xhr;
			});

			xhr.send(form);
			// return xhr;
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
		try {
			const response = await sendChunk(chunk, index);
			if (!response) return;
			if (response.status === 200 || response.status === 201 || response.status === 204) {
				if (totalChunks > 1) {
					// Calculate the progress based on the filesize, the total amount of chunks and the chunk index
					const percentProgress = Math.round((100 / uploader.totalChunks) * index);
					options.onProgress?.(uuid, percentProgress);
					console.log('[ChibiUploader] Progress:', percentProgress, '%');
				}
			} else if ([408, 502, 503, 504].includes(response.status)) {
				if (uploader.paused || uploader.offline) return;
				console.log('408, 502, 503, 504');
				manageRetries(index);
			} else {
				if (uploader.paused || uploader.offline) return;
				options.onError?.(uuid, new Error(`Server responded with ${response.status}. Stopping upload`));
			}
		} catch (error: any) {
			if (uploader.paused || uploader.offline) return;
			console.log(error);
			console.log('outer catch');
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
		console.log('[ChibiUploader] Upload finished');
		options.onFinish?.(uuid, 'url');
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