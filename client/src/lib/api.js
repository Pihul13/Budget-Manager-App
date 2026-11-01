import { createBackupDownload, localApiRequest } from "./localApi.js";

function request(url, options = {}) {
  return localApiRequest(url, options);
}

export const api = {
  get: (url) => request(url),
  post: (url, body) =>
    request(url, { method: "POST", body: JSON.stringify(body) }),
  put: (url, body) =>
    request(url, { method: "PUT", body: JSON.stringify(body) }),
  del: (url) => request(url, { method: "DELETE" }),
};

export async function downloadBackup() {
  createBackupDownload(await localApiRequest("/api/backup/export"));
}
