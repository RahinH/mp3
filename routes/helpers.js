// Shared helpers for both resources.

// Status returned by successful DELETE. Spec lists 204 among required codes;
// 200 lets us send { message, data }. If submit.js complains, change to 204.
const DELETE_STATUS = 200;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID_RE = /^[a-fA-F0-9]{24}$/;
const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

function send(res, status, message, data) {
  if (status === 204) return res.status(204).end();
  return res.status(status).json({ message, data: data === undefined ? null : data });
}

// Parse a JSON query-string parameter. Returns undefined when absent.
function parseJsonParam(query, name, { mustBeObject = true } = {}) {
  const raw = query[name];
  if (raw === undefined || raw === '') return undefined;
  let val;
  try {
    val = JSON.parse(raw);
  } catch (e) {
    throw new ApiError(400, `Invalid JSON in "${name}" parameter`);
  }
  if (mustBeObject && (val === null || typeof val !== 'object' || Array.isArray(val))) {
    throw new ApiError(400, `"${name}" parameter must be a JSON object`);
  }
  return val;
}

function parseIntParam(query, name) {
  const raw = query[name];
  if (raw === undefined || raw === '') return undefined;
  let val;
  try {
    val = JSON.parse(raw);
  } catch (e) {
    throw new ApiError(400, `"${name}" must be a non-negative integer`);
  }
  if (!Number.isInteger(val) || val < 0) {
    throw new ApiError(400, `"${name}" must be a non-negative integer`);
  }
  return val;
}

function parseCount(query) {
  const raw = query.count;
  if (raw === undefined || raw === '') return false;
  if (raw === 'true' || raw === true) return true;
  if (raw === 'false' || raw === false) return false;
  throw new ApiError(400, '"count" must be true or false');
}

// Build and run a collection query using Mongoose methods.
async function collectionGet(Model, query, defaultLimit) {
  const where = parseJsonParam(query, 'where') || {};
  const sort = parseJsonParam(query, 'sort');
  const select = parseJsonParam(query, 'select');
  const skip = parseIntParam(query, 'skip');
  let limit = parseIntParam(query, 'limit');
  const count = parseCount(query);

  try {
    if (count) {
      const q = Model.countDocuments(where);
      if (skip !== undefined) q.skip(skip);
      if (limit !== undefined) q.limit(limit);
      return await q.exec();
    }
    if (limit === undefined) limit = defaultLimit;
    const q = Model.find(where);
    if (sort) q.sort(sort);
    if (select) q.select(select);
    if (skip !== undefined) q.skip(skip);
    if (limit !== undefined && limit !== null) q.limit(limit);
    return await q.exec();
  } catch (e) {
    // Bad filters / projections / sort specs are client errors.
    if (isClientQueryError(e)) throw new ApiError(400, 'Invalid query parameters');
    throw e;
  }
}

function isClientQueryError(e) {
  if (!e) return false;
  if (e.name === 'CastError' || e.name === 'StrictModeError' || e.name === 'ObjectParameterError') return true;
  if (e.name === 'MongoServerError' && (e.code === 2 || e.code === 31254 || e.code === 31253 || e.code === 15974 || e.code === 17312)) return true;
  if (e.name === 'MongoServerError' && /projection|sort|operator|\$/.test(e.message || '')) return true;
  if (e instanceof TypeError || e instanceof SyntaxError) return true;
  return false;
}

// GET /:id with optional select only.
async function getById(Model, id, query, label) {
  const select = parseJsonParam(query, 'select');
  if (!isValidId(id)) throw new ApiError(404, `${label} not found`);
  let doc;
  try {
    const q = Model.findById(id);
    if (select) q.select(select);
    doc = await q.exec();
  } catch (e) {
    if (isClientQueryError(e)) throw new ApiError(400, 'Invalid select parameter');
    throw e;
  }
  if (!doc) throw new ApiError(404, `${label} not found`);
  return doc;
}

// Wrap async route handlers and convert errors to sane JSON responses.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, e.message, null);
    console.error(e);
    return send(res, 500, 'Internal server error', null);
  }
};

module.exports = {
  ApiError,
  DELETE_STATUS,
  isValidId,
  send,
  collectionGet,
  getById,
  handle
};
