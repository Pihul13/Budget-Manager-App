import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  createLocalId,
  exportLocalBackup,
  importLocalBackup,
  NO_CHANGE,
  readLocalData,
  updateLocalData,
} from "./localVault.js";

const COLLECTIONS = [
  "accounts",
  "categories",
  "transactions",
  "budgets",
  "goals",
  "recurring",
  "settings",
  "funds",
];
const REF_FIELDS = [
  "accountId",
  "fromAccountId",
  "toAccountId",
  "categoryId",
  "subcategoryId",
  "goalId",
  "fundId",
  "fromFundId",
  "fromGoalId",
  "toFundId",
  "toGoalId",
  "recurringRuleId",
  "holdingAccountId",
];

const idOf = (value) => String(value?._id ?? value ?? "");
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const normalizeId = (value) => (value === "" ? null : value ?? null);
const monthBounds = (month) => {
  const [year, monthNumber] = month.split("-").map(Number);
  return [
    new Date(Date.UTC(year, monthNumber - 1, 1)),
    new Date(Date.UTC(year, monthNumber, 1)),
  ];
};

function collection(data, name) {
  return data[name];
}

function findById(data, name, id) {
  return collection(data, name).find((row) => idOf(row._id) === idOf(id));
}

function requireRecord(data, name, id, label) {
  const record = findById(data, name, id);
  if (!record) throw new Error(`${label} not found.`);
  return record;
}

function populateTransaction(transaction, data) {
  const result = clone(transaction);
  for (const field of REF_FIELDS) {
    const lowered = field.toLowerCase();
    const name =
      lowered.includes("account")
        ? "accounts"
        : lowered.includes("category")
          ? "categories"
          : lowered.includes("fund")
            ? "funds"
            : lowered.includes("goal")
              ? "goals"
              : lowered.includes("recurringrule")
                ? "recurring"
                : null;
    if (!name || !result[field]) continue;
    result[field] = findById(data, name, result[field]) || result[field];
  }
  return result;
}

function accountDelta(transaction, accountId) {
  const id = idOf(accountId);
  if (transaction.type === "income" && idOf(transaction.accountId) === id)
    return Number(transaction.amount);
  if (transaction.type === "expense" && idOf(transaction.accountId) === id)
    return -Number(transaction.amount);
  if (transaction.type === "transfer") {
    if (idOf(transaction.fromAccountId) === id) return -Number(transaction.amount);
    if (idOf(transaction.toAccountId) === id) return Number(transaction.amount);
  }
  return 0;
}

function earmarkDelta(transaction, kind, bucketId, accountId) {
  const bucket = idOf(bucketId);
  const account = idOf(accountId);
  if (transaction.type === "reallocation") {
    const from = kind === "fund" ? transaction.fromFundId : transaction.fromGoalId;
    const to = kind === "fund" ? transaction.toFundId : transaction.toGoalId;
    if (idOf(from) === bucket && idOf(transaction.accountId) === account)
      return -Number(transaction.amount);
    if (idOf(to) === bucket && idOf(transaction.accountId) === account)
      return Number(transaction.amount);
    return 0;
  }
  if (idOf(kind === "fund" ? transaction.fundId : transaction.goalId) !== bucket)
    return 0;
  if (transaction.type === "expense")
    return idOf(transaction.accountId) === account
      ? -Number(transaction.amount)
      : 0;
  if (transaction.type !== "transfer") return 0;
  if (kind === "fund" && transaction.fundAction === "withdrawal")
    return idOf(transaction.fromAccountId) === account
      ? -Number(transaction.amount)
      : 0;
  return idOf(transaction.toAccountId) === account
    ? Number(transaction.amount)
    : 0;
}

function accountBalances(data) {
  return data.accounts
    .filter((account) => !account.archived)
    .map((account) => {
      const flow = data.transactions.reduce(
        (sum, transaction) => sum + accountDelta(transaction, account._id),
        0,
      );
      const owed =
        account.type === "credit_card" ? Math.max(0, -flow) : null;
      return {
        ...account,
        balance:
          account.type === "credit_card"
            ? -owed
            : Number(account.balanceAdjustment || 0) + flow,
        owed,
        used: owed,
        available:
          account.type === "credit_card" && account.creditLimit != null
            ? Math.max(0, Number(account.creditLimit) - owed)
            : null,
        ...(account.type === "credit_card"
          ? creditCardStatement(account, data.transactions)
          : {}),
      };
    })
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function processDueLocalPayments() {
  await updateLocalData((data) => {
    let changed = false;
    const today = new Date();
    const todayUtc = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    );
    for (const card of data.accounts.filter(
      (row) => row.type === "credit_card" && !row.archived && row.autoPayEnabled,
    )) {
      const paymentAccount = findById(data, "accounts", card.paymentAccountId);
      const dueDay = Number(card.dueDate);
      const billingDay = Number(card.billingDate);
      if (
        !paymentAccount ||
        paymentAccount.archived ||
        paymentAccount.type === "credit_card" ||
        !Number.isInteger(dueDay) ||
        dueDay < 1 ||
        dueDay > 31 ||
        !Number.isInteger(billingDay) ||
        billingDay < 1 ||
        billingDay > 31
      ) continue;

      const enabledAt = new Date(card.autoPayEnabledAt || card.updatedAt || card.createdAt);
      if (Number.isNaN(enabledAt.getTime())) continue;
      const firstDay = new Date(Date.UTC(
        enabledAt.getUTCFullYear(),
        enabledAt.getUTCMonth(),
        enabledAt.getUTCDate(),
      ));
      for (
        let year = enabledAt.getUTCFullYear(), month = enabledAt.getUTCMonth();
        year < today.getUTCFullYear() ||
        (year === today.getUTCFullYear() && month <= today.getUTCMonth());
        month++
      ) {
        if (month > 11) {
          year++;
          month = 0;
        }
        const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        const dueDate = new Date(Date.UTC(year, month, Math.min(dueDay, lastDay)));
        if (dueDate < firstDay || dueDate.getTime() > todayUtc) continue;

        const dueKey = dueDate.toISOString().slice(0, 10);
        const autoPaymentKey = `${card._id}:${dueKey}`;
        if (data.transactions.some((row) => row.autoPaymentKey === autoPaymentKey)) continue;

        const throughDueDate = new Date(dueDate);
        throughDueDate.setUTCHours(23, 59, 59, 999);
        const statementAmount = creditCardStatement(
          card,
          data.transactions,
          throughDueDate,
        ).statementAmount || 0;
        const nextDay = new Date(dueDate);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        const laterPayments = data.transactions
          .filter((row) =>
            row.type === "transfer" &&
            idOf(row.toAccountId) === idOf(card._id) &&
            new Date(row.date) >= nextDay &&
            new Date(row.date) <= today,
          )
          .reduce((sum, row) => sum + Number(row.amount), 0);
        const amount = Math.max(0, statementAmount - laterPayments);
        if (!amount) continue;
        data.transactions.push(createdRecord({
          type: "transfer",
          amount,
          fromAccountId: card.paymentAccountId,
          toAccountId: card._id,
          date: dueDate.toISOString(),
          description: "Automatic credit card payment",
          note: `Statement payment due ${dueKey}`,
          autoPaymentKey,
        }));
        changed = true;
      }
    }
    return changed ? true : NO_CHANGE;
  });
}

function creditCardStatement(account, transactions, asOf = new Date()) {
  const dueDay = Number(account.dueDate);
  const billingDay = Number(account.billingDate);
  if (
    !Number.isInteger(dueDay) ||
    dueDay < 1 ||
    dueDay > 31 ||
    !Number.isInteger(billingDay) ||
    billingDay < 1 ||
    billingDay > 31
  ) {
    return { statementAmount: null, statementDate: null, nextDueDate: null };
  }
  const onDay = (year, month, day) =>
    new Date(Date.UTC(year, month, Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())));
  const today = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  let nextDue = onDay(asOf.getUTCFullYear(), asOf.getUTCMonth(), dueDay);
  if (nextDue.getTime() < today) {
    nextDue = onDay(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, dueDay);
  }
  const statementDate = onDay(
    nextDue.getUTCFullYear(),
    nextDue.getUTCMonth() - (dueDay <= billingDay ? 1 : 0),
    billingDay,
  );
  const statementEnd = statementDate.getTime() + 86_400_000;
  let amount = 0;
  for (const transaction of transactions) {
    const date = new Date(transaction.date).getTime();
    if (date > asOf.getTime()) continue;
    if (date < statementEnd) amount -= accountDelta(transaction, account._id);
    else if (
      (transaction.type === "income" &&
        idOf(transaction.accountId) === idOf(account._id)) ||
      (transaction.type === "transfer" &&
        idOf(transaction.toAccountId) === idOf(account._id))
    ) {
      amount -= Number(transaction.amount);
    }
  }
  return {
    statementAmount: Math.max(0, amount),
    statementDate,
    nextDueDate: nextDue,
  };
}

function validateAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0.01)
    throw new Error("Enter an amount greater than zero.");
  return value;
}

function calculateBucketBalance(data, kind, bucketId, accountId, excludeId) {
  return data.transactions
    .filter((entry) => idOf(entry._id) !== idOf(excludeId))
    .reduce(
      (sum, entry) =>
        sum + earmarkDelta(entry, kind, bucketId, accountId),
      0,
    );
}

function validateTransaction(data, rows, excludeId) {
  const funds = rows.funds;
  const goals = rows.goals;
  const accounts = rows.accounts;
  data.amount = validateAmount(data.amount);
  data.date = new Date(data.date).toISOString();
  for (const field of [
    "accountId", "fromAccountId", "toAccountId", "categoryId",
    "subcategoryId", "goalId", "fundId", "fromFundId", "fromGoalId",
    "toFundId", "toGoalId",
  ]) data[field] = normalizeId(data[field]);

  if (data.type === "reallocation") {
    const sources = [data.fromFundId, data.fromGoalId].filter(Boolean);
    const destinations = [data.toFundId, data.toGoalId].filter(Boolean);
    if (sources.length !== 1 || destinations.length !== 1)
      throw new Error("Choose one source and one destination fund or goal.");
    if (!data.accountId || !accounts.find((row) => idOf(row._id) === idOf(data.accountId) && !row.archived))
      throw new Error("Select an active account holding the earmarked money.");
    const sourceKind = data.fromFundId ? "fund" : "goal";
    const destinationKind = data.toFundId ? "fund" : "goal";
    const sourceId = data.fromFundId || data.fromGoalId;
    const destinationId = data.toFundId || data.toGoalId;
    const sourceRows = sourceKind === "fund" ? funds : goals;
    const destinationRows = destinationKind === "fund" ? funds : goals;
    if (
      (sourceKind === destinationKind && idOf(sourceId) === idOf(destinationId)) ||
      !sourceRows.some((row) => idOf(row._id) === idOf(sourceId) && !row.archived) ||
      !destinationRows.some((row) => idOf(row._id) === idOf(destinationId) && !row.archived)
    ) throw new Error("Choose a valid, different source and destination.");
    if (calculateBucketBalance(rows, sourceKind, sourceId, data.accountId, excludeId) < data.amount)
      throw new Error("Reallocation exceeds the available balance in this account.");
    data.fromFundId = sourceKind === "fund" ? sourceId : null;
    data.fromGoalId = sourceKind === "goal" ? sourceId : null;
    data.toFundId = destinationKind === "fund" ? destinationId : null;
    data.toGoalId = destinationKind === "goal" ? destinationId : null;
    Object.assign(data, {
      fundId: null, goalId: null, fundAction: null, fromAccountId: null,
      toAccountId: null, categoryId: null, subcategoryId: null, paidTo: "",
    });
    return;
  }

  data.fromFundId = data.fromGoalId = data.toFundId = data.toGoalId = null;
  if (data.type === "expense" || data.type === "income") {
    if (!data.accountId) throw new Error("Account is required.");
    if (data.type === "income" && (data.fundId || data.goalId || data.fundAction))
      throw new Error("Funds and goals can only be tagged to expenses or transfers.");
    if (data.type === "expense" && data.fundId && data.goalId)
      throw new Error("An expense can be tagged to a goal or a fund, not both.");
    if (data.type === "expense") {
      const kind = data.fundId ? "fund" : data.goalId ? "goal" : null;
      if (kind) {
        const bucket = kind === "fund" ? funds : goals;
        if (!bucket.some((row) => idOf(row._id) === idOf(data[`${kind}Id`]) && !row.archived))
          throw new Error(`${kind === "fund" ? "Fund" : "Goal"} not found.`);
        if (calculateBucketBalance(rows, kind, data[`${kind}Id`], data.accountId, excludeId) < data.amount)
          throw new Error(`Spending exceeds the available ${kind} balance in this account.`);
        if (!data.paidTo?.trim()) throw new Error("Enter who the money was paid to.");
        data.fundAction = kind === "fund" ? "withdrawal" : null;
      } else data.fundAction = null;
    } else data.fundAction = null;
    return;
  }

  if (data.type !== "transfer")
    throw new Error("Invalid transaction type.");
  if (!data.fromAccountId || !data.toAccountId)
    throw new Error("Both transfer accounts are required.");
  if (idOf(data.fromAccountId) === idOf(data.toAccountId))
    throw new Error("Transfer accounts must be different.");
  if (data.fundId && data.goalId)
    throw new Error("A transfer can be tagged to a goal or a fund, not both.");
  if (data.fundId) {
    if (!data.fundAction)
      throw new Error("Choose whether this transfer adds to or withdraws from the fund.");
    if (!funds.some((row) => idOf(row._id) === idOf(data.fundId) && !row.archived))
      throw new Error("Fund not found.");
    if (
      data.fundAction === "withdrawal" &&
      calculateBucketBalance(rows, "fund", data.fundId, data.fromAccountId, excludeId) < data.amount
    ) throw new Error("Withdrawal exceeds the available fund balance in this account.");
  } else {
    if (data.fundAction) throw new Error("Select a fund for this fund action.");
    if (data.goalId && !goals.some((row) => idOf(row._id) === idOf(data.goalId) && !row.archived))
      throw new Error("Goal not found.");
    data.fundAction = null;
  }
}

function goalList(data) {
  const accounts = Object.fromEntries(data.accounts.map((row) => [idOf(row._id), row]));
  const entries = data.transactions;
  return data.goals.filter((goal) => !goal.archived).map((goal) => {
    const related = entries.filter((entry) =>
      [entry.goalId, entry.fromGoalId, entry.toGoalId].some((id) => idOf(id) === idOf(goal._id)),
    );
    const saved = Math.max(0, related.reduce((sum, entry) => {
      const acct = entry.accountId || entry.toAccountId || entry.fromAccountId;
      return sum + earmarkDelta(entry, "goal", goal._id, acct);
    }, 0));
    const balances = new Map();
    for (const entry of related) {
      const acctId = idOf(entry.type === "transfer" ? entry.toAccountId : entry.accountId);
      if (!acctId) continue;
      const acct = accounts[acctId];
      const item = balances.get(acctId) || {
        accountId: acctId,
        accountName: acct?.name || "",
        amount: 0,
      };
      item.amount += earmarkDelta(entry, "goal", goal._id, acctId);
      balances.set(acctId, item);
    }
    return {
      ...goal,
      holdingAccountId: findById(data, "accounts", goal.holdingAccountId) || goal.holdingAccountId,
      saved,
      remaining: Math.max(0, Number(goal.targetAmount) - saved),
      progress: goal.targetAmount ? Math.min(100, (saved / goal.targetAmount) * 100) : 0,
      storageByAccount: [...balances.values()].filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount),
    };
  });
}

function fundList(data) {
  return data.funds.filter((fund) => !fund.archived).map((fund) => {
    const entries = data.transactions.filter((entry) =>
      [entry.fundId, entry.fromFundId, entry.toFundId].some((id) => idOf(id) === idOf(fund._id)),
    );
    const balances = new Map();
    for (const entry of entries) {
      const acctId = idOf(
        entry.type === "reallocation" || entry.type === "expense"
          ? entry.accountId
          : entry.fundAction === "withdrawal"
            ? entry.fromAccountId
            : entry.toAccountId,
      );
      if (!acctId) continue;
      const acct = findById(data, "accounts", acctId);
      const item = balances.get(acctId) || { accountId: acctId, accountName: acct?.name || "", amount: 0 };
      item.amount += earmarkDelta(entry, "fund", fund._id, acctId);
      balances.set(acctId, item);
    }
    const storageByAccount = [...balances.values()].filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount);
    return { ...fund, balance: [...balances.values()].reduce((sum, item) => sum + item.amount, 0), storageByAccount };
  });
}

function buildStats(data, month) {
  const [start, end] = monthBounds(month);
  const txns = data.transactions.filter((row) => {
    const date = new Date(row.date);
    return date >= start && date < end;
  });
  const income = txns.filter((row) => row.type === "income").reduce((sum, row) => sum + Number(row.amount), 0);
  const expense = txns.filter((row) => row.type === "expense").reduce((sum, row) => sum + Number(row.amount), 0);
  const byCategory = {};
  for (const row of txns.filter((item) => item.type === "expense")) {
    const name = findById(data, "categories", row.categoryId)?.name || "Uncategorized";
    byCategory[name] = (byCategory[name] || 0) + Number(row.amount);
  }
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const byDay = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const sameDay = txns.filter((row) => new Date(row.date).getUTCDate() === day);
    return {
      day: String(day),
      income: sameDay.filter((row) => row.type === "income").reduce((sum, row) => sum + Number(row.amount), 0),
      expense: sameDay.filter((row) => row.type === "expense").reduce((sum, row) => sum + Number(row.amount), 0),
    };
  });
  const accounts = accountBalances(data);
  const assets = accounts.filter((row) => row.type !== "credit_card").reduce((sum, row) => sum + row.balance, 0);
  const liabilities = accounts.filter((row) => row.type === "credit_card").reduce((sum, row) => sum + Math.max(0, -row.balance), 0);
  return {
    income, expense, savings: income - expense, byCategory, byDay,
    assets, liabilities, netWorth: assets - liabilities,
    accountBalances: accounts,
  };
}

function historyStats(data, years) {
  const current = new Date();
  const monthly = [];
  for (let offset = years * 12 - 1; offset >= 0; offset--) {
    const date = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - offset, 1));
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const [start, end] = monthBounds(month);
    const txns = data.transactions.filter((row) => new Date(row.date) >= start && new Date(row.date) < end);
    monthly.push({
      month,
      income: txns.filter((row) => row.type === "income").reduce((sum, row) => sum + Number(row.amount), 0),
      expense: txns.filter((row) => row.type === "expense").reduce((sum, row) => sum + Number(row.amount), 0),
    });
  }
  const accounts = accountBalances(data);
  const assets = accounts.filter((row) => row.type !== "credit_card").reduce((sum, row) => sum + row.balance, 0);
  const liabilities = accounts.filter((row) => row.type === "credit_card").reduce((sum, row) => sum + Math.max(0, -row.balance), 0);
  return { monthly, currentNetWorth: assets - liabilities };
}

function addFrequency(value, frequency, interval = 1) {
  const date = new Date(value);
  if (frequency === "daily") date.setUTCDate(date.getUTCDate() + interval);
  else if (frequency === "weekly") date.setUTCDate(date.getUTCDate() + 7 * interval);
  else if (frequency === "monthly") date.setUTCMonth(date.getUTCMonth() + interval);
  else if (frequency === "yearly") date.setUTCFullYear(date.getUTCFullYear() + interval);
  return date.toISOString();
}

function createdRecord(body) {
  const timestamp = now();
  return { ...clone(body), _id: createLocalId(), createdAt: timestamp, updatedAt: timestamp };
}

function updateRecord(rows, id, body) {
  const index = rows.findIndex((row) => idOf(row._id) === idOf(id));
  if (index < 0) throw new Error("Record not found.");
  rows[index] = { ...rows[index], ...clone(body), updatedAt: now() };
  return rows[index];
}

function fromBackup(data) {
  return { version: 1, exportedAt: now(), data: Object.fromEntries(COLLECTIONS.map((name) => [name, data[name]])) };
}

function queryTransactions(data, url) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = Number(url.searchParams.get("limit") || 200);
  return data.transactions
    .filter((row) => (!from || new Date(row.date) >= new Date(from)) && (!to || new Date(row.date) < new Date(to)))
    .sort((a, b) => new Date(b.date) - new Date(a.date) || new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit)
    .map((row) => populateTransaction(row, data));
}

function referenceCollection(field) {
  const lowered = field.toLowerCase();
  if (lowered.includes("account")) return "accounts";
  if (lowered.includes("category")) return "categories";
  if (lowered.includes("fund")) return "funds";
  if (lowered.includes("goal")) return "goals";
  if (lowered.includes("rule")) return "recurring";
  return null;
}

function populateRecord(row, data, fields) {
  const result = clone(row);
  for (const field of fields) {
    const name = referenceCollection(field);
    if (name && result[field]) result[field] = findById(data, name, result[field]) || result[field];
  }
  return result;
}

async function handleRead(path, url) {
  if (path === "/api/accounts") await processDueLocalPayments();
  const data = await readLocalData();
  if (path === "/api/accounts") return accountBalances(data);
  if (path === "/api/categories") return data.categories.filter((row) => !row.archived).sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  if (path === "/api/transactions") return queryTransactions(data, url);
  if (path === "/api/goals") return goalList(data);
  if (path === "/api/funds") return fundList(data);
  if (path === "/api/recurring") return data.recurring
    .map((row) => populateRecord(row, data, ["accountId", "fromAccountId", "toAccountId", "categoryId", "subcategoryId"]))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || new Date(a.nextRunDate) - new Date(b.nextRunDate));
  if (path === "/api/settings") {
    if (!data.settings.length) return { displayName: "", theme: "light" };
    return data.settings[0];
  }
  if (path === "/api/stats/history") return historyStats(data, Number(url.searchParams.get("years") || 1));
  let match = path.match(/^\/api\/stats\/month\/(\d{4}-\d{2})$/);
  if (match) return buildStats(data, match[1]);
  match = path.match(/^\/api\/budgets\/(\d{4}-\d{2})$/);
  if (match) return data.budgets.find((row) => row.month === match[1]) || null;
  match = path.match(/^\/api\/goals\/([^/]+)\/history$/);
  if (match) return data.transactions
    .filter((row) => [row.goalId, row.fromGoalId, row.toGoalId].some((id) => idOf(id) === match[1]))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((row) => populateRecord(row, data, ["accountId", "fromAccountId", "toAccountId", "fromFundId", "fromGoalId", "toFundId", "toGoalId"]));
  match = path.match(/^\/api\/funds\/([^/]+)\/history$/);
  if (match) return data.transactions
    .filter((row) => [row.fundId, row.fromFundId, row.toFundId].some((id) => idOf(id) === match[1]))
    .sort((a, b) => new Date(b.date) - new Date(a.date) || new Date(b.createdAt) - new Date(a.createdAt))
    .map((row) => populateRecord(row, data, ["accountId", "fromAccountId", "toAccountId", "fromFundId", "fromGoalId", "toFundId", "toGoalId"]));
  throw new Error(`Local data operation is not supported: GET ${path}`);
}

async function handleWrite(method, path, body) {
  if (path === "/api/backup/export" && method === "GET") return exportLocalBackup();
  if (path === "/api/backup/import" && method === "POST") return importLocalBackup(body);
  return updateLocalData((data) => {
    let match;
    if (path === "/api/accounts" && method === "POST") {
      const account = createdRecord({ ...body, balanceAdjustment: Number(body.balanceAdjustment || 0), archived: false });
      data.accounts.push(account);
      return account;
    }
    match = path.match(/^\/api\/accounts\/([^/]+)$/);
    if (match && method === "PUT") {
      const current = requireRecord(data, "accounts", match[1], "Account");
      const allowed = ["name", "type", "color", "logo", "creditLimit", "dueDate", "billingDate", "paymentAccountId", "autoPayEnabled", "autoPayEnabledAt"];
      const updates = Object.fromEntries(allowed.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
      if (body.currentBalance !== undefined) {
        if (!Number.isFinite(Number(body.currentBalance))) throw new Error("Enter a valid account balance.");
        if ((updates.type || current.type) === "credit_card") throw new Error("Credit card balances are calculated from card transactions.");
        const flow = data.transactions.reduce((sum, row) => sum + accountDelta(row, current._id), 0);
        current.balanceAdjustment = Number(body.currentBalance) - flow;
      }
      if (Object.hasOwn(body, "autoPayEnabled")) {
        updates.autoPayEnabledAt = body.autoPayEnabled
          ? current.autoPayEnabled
            ? current.autoPayEnabledAt
            : now()
          : null;
      }
      const nextAccount = { ...current, ...updates };
      if (nextAccount.autoPayEnabled) {
        if (nextAccount.type !== "credit_card")
          throw new Error("Automatic payments can only be enabled for credit cards.");
        const dueDay = Number(nextAccount.dueDate);
        const billingDay = Number(nextAccount.billingDate);
        if (
          !nextAccount.paymentAccountId ||
          !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31 ||
          !Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31
        ) throw new Error("Automatic payment requires a payment account, billing day, and due day.");
        const paymentAccount = findById(data, "accounts", nextAccount.paymentAccountId);
        if (!paymentAccount || paymentAccount.archived || paymentAccount.type === "credit_card")
          throw new Error("Choose an active non-credit-card payment account.");
      }
      return updateRecord(data.accounts, match[1], updates);
    }
    if (match && method === "DELETE") {
      if (data.transactions.some((row) => [row.accountId, row.fromAccountId, row.toAccountId].some((id) => idOf(id) === match[1])))
        throw new Error("Account has transactions. Archive it instead.");
      data.accounts = data.accounts.filter((row) => idOf(row._id) !== match[1]);
      return { ok: true };
    }

    if (path === "/api/categories" && method === "POST") {
      const row = createdRecord({ ...body, parentId: normalizeId(body.parentId), archived: false });
      data.categories.push(row);
      return row;
    }
    match = path.match(/^\/api\/categories\/([^/]+)$/);
    if (match && method === "PUT")
      return updateRecord(data.categories, match[1], { ...body, parentId: normalizeId(body.parentId) });
    if (match && method === "DELETE") {
      if (data.transactions.some((row) => [row.categoryId, row.subcategoryId].some((id) => idOf(id) === match[1])))
        throw new Error("Category is used by transactions. Archive it instead.");
      data.categories = data.categories.filter((row) => idOf(row._id) !== match[1] && idOf(row.parentId) !== match[1]);
      return { ok: true };
    }

    if (path === "/api/transactions" && method === "POST") {
      const row = { ...body };
      validateTransaction(row, data, null);
      const created = createdRecord(row);
      data.transactions.push(created);
      return populateTransaction(created, data);
    }
    match = path.match(/^\/api\/transactions\/([^/]+)$/);
    if (match && method === "PUT") {
      const existing = requireRecord(data, "transactions", match[1], "Transaction");
      if (existing.autoPaymentKey) throw new Error("Automatic credit-card payments cannot be edited.");
      const row = { ...body };
      validateTransaction(row, data, match[1]);
      return populateTransaction(updateRecord(data.transactions, match[1], row), data);
    }
    if (match && method === "DELETE") {
      const existing = requireRecord(data, "transactions", match[1], "Transaction");
      if (existing.autoPaymentKey) throw new Error("Automatic credit-card payments cannot be deleted.");
      data.transactions = data.transactions.filter((row) => idOf(row._id) !== match[1]);
      return { ok: true };
    }

    if (path === "/api/budgets" && method === "PUT") {
      throw new Error("A budget month is required.");
    }
    match = path.match(/^\/api\/budgets\/(\d{4}-\d{2})$/);
    if (match && method === "PUT") {
      const budget = {
        month: match[1],
        totalLimit: Number(body.totalLimit || 0),
        categoryLimits: body.categoryLimits || [],
        subcategoryLimits: body.subcategoryLimits || [],
      };
      const existing = data.budgets.findIndex((row) => row.month === match[1]);
      if (existing < 0) {
        const created = createdRecord(budget);
        data.budgets.push(created);
        return created;
      }
      return updateRecord(data.budgets, data.budgets[existing]._id, budget);
    }

    if (path === "/api/goals" && method === "POST") {
      const row = createdRecord({ ...body, targetAmount: validateAmount(body.targetAmount), archived: false });
      data.goals.push(row);
      return row;
    }
    match = path.match(/^\/api\/goals\/([^/]+)$/);
    if (match && method === "PUT") return updateRecord(data.goals, match[1], body);
    if (match && method === "DELETE") {
      if (data.transactions.some((row) => [row.goalId, row.fromGoalId, row.toGoalId].some((id) => idOf(id) === match[1])))
        throw new Error("Goal has contribution history. Archive it instead.");
      data.goals = data.goals.filter((row) => idOf(row._id) !== match[1]);
      return { ok: true };
    }

    if (path === "/api/funds" && method === "POST") {
      const row = createdRecord({ ...body, archived: false });
      data.funds.push(row);
      return row;
    }
    match = path.match(/^\/api\/funds\/([^/]+)$/);
    if (match && method === "PUT") return updateRecord(data.funds, match[1], { name: body.name, color: body.color });
    if (match && method === "DELETE") {
      if (data.transactions.some((row) => [row.fundId, row.fromFundId, row.toFundId].some((id) => idOf(id) === match[1])))
        throw new Error("Fund has transaction history and cannot be deleted.");
      data.funds = data.funds.filter((row) => idOf(row._id) !== match[1]);
      return { ok: true };
    }

    if (path === "/api/recurring" && method === "POST") {
      const row = createdRecord(body);
      data.recurring.push(row);
      return row;
    }
    match = path.match(/^\/api\/recurring\/([^/]+)\/(execute|skip)$/);
    if (match && method === "POST") {
      const rule = requireRecord(data, "recurring", match[1], "Rule");
      if (match[2] === "skip") {
        return updateRecord(data.recurring, match[1], { nextRunDate: addFrequency(rule.nextRunDate, rule.frequency, rule.interval) });
      }
      const txn = createdRecord({
        type: rule.type, amount: rule.amount, accountId: rule.accountId,
        fromAccountId: rule.fromAccountId, toAccountId: rule.toAccountId,
        categoryId: rule.categoryId, subcategoryId: rule.subcategoryId,
        description: rule.name, note: rule.note, date: now(),
        recurringRuleId: rule._id,
      });
      data.transactions.push(txn);
      updateRecord(data.recurring, match[1], { nextRunDate: addFrequency(rule.nextRunDate, rule.frequency, rule.interval) });
      return populateTransaction(txn, data);
    }
    match = path.match(/^\/api\/recurring\/([^/]+)$/);
    if (match && method === "PUT")
      return updateRecord(data.recurring, match[1], Object.fromEntries(Object.entries(body).map(([key, value]) => [key, ["accountId", "fromAccountId", "toAccountId", "categoryId", "subcategoryId"].includes(key) ? normalizeId(value) : value])));
    if (match && method === "DELETE") {
      data.recurring = data.recurring.filter((row) => idOf(row._id) !== match[1]);
      return { ok: true };
    }

    if (path === "/api/settings" && method === "PUT") {
      const allowed = {};
      if (Object.hasOwn(body, "theme")) {
        if (!["light", "dark", "system"].includes(body.theme)) throw new Error("Theme must be light, dark, or system.");
        allowed.theme = body.theme;
      }
      if (Object.hasOwn(body, "displayName")) {
        const displayName = String(body.displayName).trim();
        if (!displayName || displayName.length > 40) throw new Error("Display name must be between 1 and 40 characters.");
        allowed.displayName = displayName;
      }
      if (!Object.keys(allowed).length) throw new Error("No supported settings were provided.");
      if (!data.settings.length) data.settings.push(createdRecord({ theme: "light", displayName: "", ...allowed }));
      else updateRecord(data.settings, data.settings[0]._id, allowed);
      return data.settings[0];
    }
    throw new Error(`Local data operation is not supported: ${method} ${path}`);
  });
}

export async function localApiRequest(url, options = {}) {
  const method = options.method || "GET";
  const parsed = new URL(url, globalThis.location?.origin || "https://local.app");
  const body = options.body ? JSON.parse(options.body) : {};
  if (method === "GET" && !parsed.pathname.startsWith("/api/backup/")) {
    return handleRead(parsed.pathname, parsed);
  }
  return handleWrite(method, parsed.pathname, body);
}

export async function createBackupDownload(payload) {
  const contents = JSON.stringify(payload, null, 2);
  if (Capacitor.isNativePlatform()) {
    const file = await Filesystem.writeFile({
      path: "personal-finance-backup.json",
      data: contents,
      directory: Directory.Cache,
    });
    await Share.share({
      title: "Finance backup",
      url: file.uri,
      dialogTitle: "Save your finance backup",
    });
    return;
  }
  const blob = new Blob([contents], { type: "application/json" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = "personal-finance-backup.json";
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
