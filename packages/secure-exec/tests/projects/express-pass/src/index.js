"use strict";

const express = require("express");
const { EventEmitter } = require("events");

// ---- App setup ----

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/hello", (req, res) => {
	res.json({ message: "hello" });
});

app.get("/users/:id", (req, res) => {
	res.json({ id: req.params.id, name: "test-user" });
});

app.post("/data", (req, res) => {
	res.json({ method: req.method, url: req.url });
});

// ---- Programmatic request dispatch ----

function dispatch(method, url) {
	return new Promise((resolve, reject) => {
		const req = new EventEmitter();
		req.method = method;
		req.url = url;
		req.headers = {};
		req.connection = { remoteAddress: "127.0.0.1" };
		req.socket = { remoteAddress: "127.0.0.1" };
		req.unpipe = () => {};
		req.pause = () => {};
		req.resume = () => {};
		req.readable = true;

		const mockSocket = {
			writable: true,
			on: () => mockSocket,
			removeListener: () => mockSocket,
			destroy: () => {},
			end: () => {},
		};

		const res = new EventEmitter();
		res.statusCode = 200;
		res.statusMessage = "OK";
		res._headers = {};
		res.headersSent = false;
		res.finished = false;
		res.writableFinished = false;
		res.writableEnded = false;
		res.socket = mockSocket;
		res.connection = mockSocket;

		res.setHeader = function (k, v) {
			this._headers[k.toLowerCase()] = v;
		};
		res.getHeader = function (k) {
			return this._headers[k.toLowerCase()];
		};
		res.removeHeader = function (k) {
			delete this._headers[k.toLowerCase()];
		};
		res.writeHead = function (code, reason, headers) {
			this.statusCode = code;
			if (typeof reason === "object") headers = reason;
			if (headers)
				Object.entries(headers).forEach(([k, v]) => this.setHeader(k, v));
			this.headersSent = true;
			return this;
		};

		let body = "";
		res.write = function (chunk) {
			body +=
				typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		};
		res.end = function (data) {
			if (data)
				body +=
					typeof data === "string" ? data : Buffer.from(data).toString();
			this.headersSent = true;
			this.finished = true;
			this.writableFinished = true;
			this.writableEnded = true;
			resolve({ status: this.statusCode, body });
		};

		app(req, res, (err) => {
			if (err) reject(err);
			else resolve({ status: 404, body: "Not Found" });
		});

		// Signal end-of-body synchronously after Express attaches middleware
		// listeners. No Content-Type → body parsers skip, so this is safe.
		req.emit("end");
	});
}

// ---- Run tests ----

async function main() {
	const results = [];

	const r1 = await dispatch("GET", "/hello");
	results.push({
		route: "GET /hello",
		status: r1.status,
		body: JSON.parse(r1.body),
	});

	const r2 = await dispatch("GET", "/users/42");
	results.push({
		route: "GET /users/42",
		status: r2.status,
		body: JSON.parse(r2.body),
	});

	const r3 = await dispatch("POST", "/data");
	results.push({
		route: "POST /data",
		status: r3.status,
		body: JSON.parse(r3.body),
	});

	console.log(JSON.stringify(results));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
