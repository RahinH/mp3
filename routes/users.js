const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const {
  ApiError, DELETE_STATUS, isValidId, send, collectionGet, getById, handle
} = require('./helpers');

const router = express.Router();

const UNASSIGN = { assignedUser: '', assignedUserName: 'unassigned' };

// --- Validation -------------------------------------------------------------

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateUserBody(body) {
  body = body || {};
  if (body.name === undefined || body.name === null || body.name === '') {
    throw new ApiError(400, 'User name is required');
  }
  if (!nonEmptyString(body.name)) throw new ApiError(400, 'User name must be a non-empty string');
  if (body.email === undefined || body.email === null || body.email === '') {
    throw new ApiError(400, 'User email is required');
  }
  if (!nonEmptyString(body.email)) throw new ApiError(400, 'User email must be a non-empty string');

  let pending = body.pendingTasks;
  if (pending === undefined || pending === null || pending === '') pending = [];
  else if (typeof pending === 'string') pending = [pending];
  if (!Array.isArray(pending)) throw new ApiError(400, 'pendingTasks must be an array of task ids');
  for (const id of pending) {
    if (typeof id !== 'string') throw new ApiError(400, 'pendingTasks must be an array of task ids');
    if (!isValidId(id)) throw new ApiError(400, `Invalid task id in pendingTasks: ${id}`);
  }
  pending = [...new Set(pending)];

  return { name: body.name.trim(), email: body.email.trim(), pendingTasks: pending };
}

// Checks that run against the DB but must happen before any write.
async function checkUserRefs(data, selfId) {
  const emailFilter = { email: data.email };
  if (selfId) emailFilter._id = { $ne: selfId };
  if (await User.exists(emailFilter)) {
    throw new ApiError(400, 'A user with this email already exists');
  }

  if (data.pendingTasks.length === 0) return [];
  const tasks = await Task.find({ _id: { $in: data.pendingTasks } });
  if (tasks.some((t) => t.completed)) {
    throw new ApiError(400, 'pendingTasks cannot contain completed tasks');
  }
  if (tasks.length !== data.pendingTasks.length) {
    throw new ApiError(404, 'One or more tasks in pendingTasks do not exist');
  }
  return tasks;
}

// Apply two-way reference updates for a user whose pendingTasks become `newIds`.
async function syncUserTasks(userId, userName, newIds, tasks) {
  // Pending tasks currently assigned to this user but no longer listed -> unassign.
  await Task.updateMany(
    { assignedUser: userId, completed: false, _id: { $nin: newIds } },
    { $set: UNASSIGN }
  );
  // Tasks still assigned to this user (incl. completed): refresh the name.
  await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: userName } });

  // Tasks moving from another user: remove from that user's pendingTasks.
  for (const t of tasks) {
    if (t.assignedUser && t.assignedUser !== userId) {
      await User.updateOne({ _id: t.assignedUser }, { $pull: { pendingTasks: String(t._id) } });
    }
  }
  if (newIds.length) {
    // Also drop these ids from any other user's list (defensive consistency).
    await User.updateMany(
      { _id: { $ne: userId }, pendingTasks: { $in: newIds } },
      { $pull: { pendingTasks: { $in: newIds } } }
    );
    await Task.updateMany(
      { _id: { $in: newIds } },
      { $set: { assignedUser: userId, assignedUserName: userName } }
    );
  }
}

// --- Routes -----------------------------------------------------------------

router.get('/', handle(async (req, res) => {
  const data = await collectionGet(User, req.query, undefined);
  send(res, 200, 'OK', data);
}));

router.post('/', handle(async (req, res) => {
  const data = validateUserBody(req.body);
  const tasks = await checkUserRefs(data, null);

  const user = new User({ name: data.name, email: data.email, pendingTasks: data.pendingTasks });
  await user.save();
  await syncUserTasks(String(user._id), user.name, data.pendingTasks, tasks);

  send(res, 201, 'User created', user);
}));

router.get('/:id', handle(async (req, res) => {
  const user = await getById(User, req.params.id, req.query, 'User');
  send(res, 200, 'OK', user);
}));

router.put('/:id', handle(async (req, res) => {
  const id = req.params.id;
  if (!isValidId(id)) throw new ApiError(404, 'User not found');
  const user = await User.findById(id);
  if (!user) throw new ApiError(404, 'User not found');

  const data = validateUserBody(req.body);
  const tasks = await checkUserRefs(data, id);

  await syncUserTasks(id, data.name, data.pendingTasks, tasks);

  user.name = data.name;
  user.email = data.email;
  user.pendingTasks = data.pendingTasks;
  await user.save();

  send(res, 200, 'User updated', user);
}));

router.delete('/:id', handle(async (req, res) => {
  const id = req.params.id;
  if (!isValidId(id)) throw new ApiError(404, 'User not found');
  const user = await User.findById(id);
  if (!user) throw new ApiError(404, 'User not found');

  await Task.updateMany({ assignedUser: id }, { $set: UNASSIGN });
  await User.deleteOne({ _id: id });

  send(res, DELETE_STATUS, 'User deleted', user);
}));

module.exports = router;
