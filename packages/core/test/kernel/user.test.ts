import { describe, it, expect } from "vitest";
import { UserManager } from "../../src/kernel/user.js";

describe("UserManager", () => {
	describe("default values", () => {
		it("uses sensible defaults when no config provided", () => {
			const user = new UserManager();
			expect(user.uid).toBe(1000);
			expect(user.gid).toBe(1000);
			expect(user.euid).toBe(1000);
			expect(user.egid).toBe(1000);
			expect(user.username).toBe("user");
			expect(user.homedir).toBe("/home/user");
			expect(user.shell).toBe("/bin/sh");
			expect(user.gecos).toBe("");
		});

		it("uses sensible defaults with empty config", () => {
			const user = new UserManager({});
			expect(user.uid).toBe(1000);
			expect(user.gid).toBe(1000);
			expect(user.username).toBe("user");
		});

		it("euid defaults to uid when not specified", () => {
			const user = new UserManager({ uid: 500 });
			expect(user.euid).toBe(500);
		});

		it("egid defaults to gid when not specified", () => {
			const user = new UserManager({ gid: 500 });
			expect(user.egid).toBe(500);
		});
	});

	describe("custom configuration", () => {
		it("accepts all custom values", () => {
			const user = new UserManager({
				uid: 501,
				gid: 502,
				euid: 0,
				egid: 0,
				username: "admin",
				homedir: "/home/admin",
				shell: "/bin/bash",
				gecos: "Admin User",
			});
			expect(user.uid).toBe(501);
			expect(user.gid).toBe(502);
			expect(user.euid).toBe(0);
			expect(user.egid).toBe(0);
			expect(user.username).toBe("admin");
			expect(user.homedir).toBe("/home/admin");
			expect(user.shell).toBe("/bin/bash");
			expect(user.gecos).toBe("Admin User");
		});

		it("allows euid/egid to differ from uid/gid", () => {
			const user = new UserManager({ uid: 1000, gid: 1000, euid: 0, egid: 0 });
			expect(user.uid).toBe(1000);
			expect(user.euid).toBe(0);
			expect(user.gid).toBe(1000);
			expect(user.egid).toBe(0);
		});
	});

	describe("root uid handling", () => {
		it("supports root uid/gid (0)", () => {
			const user = new UserManager({ uid: 0, gid: 0, username: "root", homedir: "/root" });
			expect(user.uid).toBe(0);
			expect(user.gid).toBe(0);
			expect(user.euid).toBe(0);
			expect(user.egid).toBe(0);
			expect(user.username).toBe("root");
			expect(user.homedir).toBe("/root");
		});
	});

	describe("getpwuid", () => {
		it("returns passwd entry for configured uid", () => {
			const user = new UserManager();
			const entry = user.getpwuid(1000);
			expect(entry).toBe("user:x:1000:1000::/home/user:/bin/sh");
		});

		it("includes gecos field in passwd entry", () => {
			const user = new UserManager({ gecos: "Test User" });
			const entry = user.getpwuid(1000);
			expect(entry).toBe("user:x:1000:1000:Test User:/home/user:/bin/sh");
		});

		it("returns passwd entry with custom config", () => {
			const user = new UserManager({
				uid: 501,
				gid: 502,
				username: "deploy",
				homedir: "/opt/deploy",
				shell: "/bin/bash",
				gecos: "Deploy User",
			});
			const entry = user.getpwuid(501);
			expect(entry).toBe("deploy:x:501:502:Deploy User:/opt/deploy:/bin/bash");
		});

		it("returns generic entry for unknown uid", () => {
			const user = new UserManager();
			const entry = user.getpwuid(9999);
			expect(entry).toBe("user9999:x:9999:9999::/home/user9999:/bin/sh");
		});

		it("returns generic entry for root uid when configured as non-root", () => {
			const user = new UserManager();
			const entry = user.getpwuid(0);
			expect(entry).toBe("user0:x:0:0::/home/user0:/bin/sh");
		});

		it("returns configured entry when configured as root", () => {
			const user = new UserManager({ uid: 0, gid: 0, username: "root", homedir: "/root" });
			const entry = user.getpwuid(0);
			expect(entry).toBe("root:x:0:0::/root:/bin/sh");
		});
	});
});
