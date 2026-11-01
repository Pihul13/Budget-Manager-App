import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import {
  changeVaultPassphrase,
  getVaultStatus,
  lockVault,
  setupVault,
  unlockVault,
} from "./localVault.js";
import { localApiRequest } from "./localApi.js";

test("keeps finance data local, encrypted, and available after unlock", async () => {
  assert.equal(await getVaultStatus(), "setup");

  await setupVault("correct horse battery");
  assert.equal(await getVaultStatus(), "locked");
  await assert.rejects(unlockVault("wrong passphrase"), /incorrect/);
  await unlockVault("correct horse battery");

  const account = await localApiRequest("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ name: "Everyday", type: "bank" }),
  });
  await localApiRequest(`/api/accounts/${account._id}`, {
    method: "PUT",
    body: JSON.stringify({ currentBalance: 100 }),
  });
  const category = await localApiRequest("/api/categories", {
    method: "POST",
    body: JSON.stringify({ name: "Food", type: "expense", parentId: "" }),
  });
  const date = new Date().toISOString();
  const expense = await localApiRequest("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      type: "expense",
      amount: 20,
      accountId: account._id,
      categoryId: category._id,
      date,
      description: "Lunch",
    }),
  });

  const savings = await localApiRequest("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ name: "Savings", type: "bank" }),
  });
  const fund = await localApiRequest("/api/funds", {
    method: "POST",
    body: JSON.stringify({ name: "Emergency" }),
  });
  const goal = await localApiRequest("/api/goals", {
    method: "POST",
    body: JSON.stringify({ name: "Trip", targetAmount: 100 }),
  });
  await localApiRequest("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      type: "transfer",
      amount: 30,
      fromAccountId: account._id,
      toAccountId: savings._id,
      fundId: fund._id,
      fundAction: "contribution",
      date,
    }),
  });
  await localApiRequest("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      type: "reallocation",
      amount: 10,
      accountId: savings._id,
      fromFundId: fund._id,
      toGoalId: goal._id,
      date,
    }),
  });
  assert.equal((await localApiRequest("/api/funds"))[0].balance, 20);
  assert.equal((await localApiRequest("/api/goals"))[0].saved, 10);

  const rule = await localApiRequest("/api/recurring", {
    method: "POST",
    body: JSON.stringify({
      name: "Pay",
      type: "income",
      amount: 50,
      accountId: account._id,
      frequency: "monthly",
      interval: 1,
      nextRunDate: date,
      enabled: true,
    }),
  });
  await localApiRequest(`/api/recurring/${rule._id}/execute`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  const accounts = await localApiRequest("/api/accounts");
  assert.equal(accounts.find((row) => row._id === account._id).balance, 100);
  const transactions = await localApiRequest(
    `/api/transactions?from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&limit=10`,
  );
  assert.equal(transactions.length, 4);
  assert.equal(
    transactions.find((row) => row._id === expense._id).categoryId.name,
    "Food",
  );

  const backup = await localApiRequest("/api/backup/export");
  assert.equal(backup.data.transactions.length, 4);
  lockVault();
  await unlockVault("correct horse battery");
  assert.equal(
    (await localApiRequest("/api/accounts")).find((row) => row._id === account._id)
      .balance,
    100,
  );

  await changeVaultPassphrase(
    "correct horse battery",
    "another strong passphrase",
  );
  lockVault();
  await assert.rejects(unlockVault("correct horse battery"), /incorrect/);
  await unlockVault("another strong passphrase");
});

test("uses a portable backup for local restore", async () => {
  const backup = await localApiRequest("/api/backup/export");
  backup.data.accounts = [];
  backup.data.categories = [];
  backup.data.transactions = [];
  await localApiRequest("/api/backup/import", {
    method: "POST",
    body: JSON.stringify(backup),
  });
  assert.deepEqual(await localApiRequest("/api/accounts"), []);
  await assert.rejects(
    localApiRequest("/api/backup/import", {
      method: "POST",
      body: JSON.stringify({ version: 1, data: {} }),
    }),
    /Invalid backup/,
  );
});
