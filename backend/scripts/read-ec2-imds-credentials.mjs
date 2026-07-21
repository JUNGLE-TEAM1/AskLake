#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import http from "node:http";
import process from "node:process";

const [, , expectedRole, outputPath] = process.argv;
if (!expectedRole || !outputPath) throw new Error("expected role and output path are required");

function request(path, { method = "GET", token } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "169.254.169.254",
      port: 80,
      path,
      method,
      headers: token
        ? { "X-aws-ec2-metadata-token": token }
        : { "X-aws-ec2-metadata-token-ttl-seconds": "300" },
      timeout: 5_000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) reject(new Error(`IMDS returned ${response.statusCode}`));
        else resolve(body.trim());
      });
    });
    request.on("timeout", () => request.destroy(new Error("IMDS request timed out")));
    request.on("error", reject);
    request.end();
  });
}

const token = await request("/latest/api/token", { method: "PUT" });
const role = await request("/latest/meta-data/iam/security-credentials/", { token });
if (role !== expectedRole) throw new Error("IMDS returned an unexpected instance profile role");
const credentials = JSON.parse(await request(`/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { token }));
if (!credentials.AccessKeyId || !credentials.SecretAccessKey || !credentials.Token) {
  throw new Error("IMDS credentials are incomplete");
}
writeFileSync(outputPath, JSON.stringify(credentials), { mode: 0o600 });
