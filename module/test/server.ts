import http from 'node:http';
import { processFile } from '../src/index';

http.createServer(async (req, res) => {
	// Sample CORS configuration, modify as needed
	res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8001');
	if (req.url === '/upload' && req.method === 'OPTIONS') {
		res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'chibi-chunk-number,chibi-chunks-total,chibi-uuid');
		res.setHeader('Access-Control-Max-Age', '86400'); // 24hrs
		res.writeHead(204, 'No Content');
		res.end();
		return;
	}

	// Sample upload endpoint
	if (req.url === '/upload' && req.method === 'POST') {
		const maxChunkSize = 90 * 1000 * 1000; // 90MB
		const maxFileSize = 100 * 1000 * 1000 * 1000; // 100GB
		const tmpDir = './tmp';
		try {
			const upload = await processFile(req, { destination: tmpDir, maxFileSize, maxChunkSize });

			if (upload.isChunkedUpload && !upload.ready) {
				return res.writeHead(204, 'OK', { 'Content-Type': 'text/plain' }).end();
			}

			/*
			 * The response object structure.
			 * Use this to perform any additional actions after the upload is complete,
			 * such as moving the file to a different location, or adding it to a database.
			 * 	{
			 * 		"isChunkedUpload":false,
			 * 		"path":"tmp\\62376102-9737-4edb-86d0-7b3b05c4cd91.exe",
			 * 		"metadata":{
			 * 			"name":"parsec-windows.exe",
			 * 			"type":"application/x-msdownload",
			 * 			"size":"2881040"
			 * 		}
			 * 	}
			 */

			return res.writeHead(201, 'OK', { 'Content-Type': 'application/json' }).end(JSON.stringify(upload));
		} catch (error: any) {
			let statusCode = 500;
			switch (error.message) {
				case 'Chunked upload is above size limit':
				case 'Chunk is too big':
				case 'File is too big':
					statusCode = 413;
				case 'Missing chibi-* headers':
				case 'chibi-uuid is not a string':
				case 'chibi-uuid does not meet the length criteria':
				case 'chibi-uuid is not a valid uuid':
				case 'Chunk is out of range':
				case 'Invalid headers':
					statusCode = 400;
			}

			return res.writeHead(statusCode, 'OK', { 'Content-Type': 'text/plain' }).end(error.message);
		}
	}
}).listen(8888, () => {
	console.log('Listening for requests on por 8888');
});
