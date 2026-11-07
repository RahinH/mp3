const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const {
  ApiError, DELETE_STATUS, isValidId, send, collectionGet, getById, handle
} = require('./helpers');

const router = express.Router();

// --- Validation -------------------------------------------------------------

function parseDeadline(v) {
  if (v === undefined || v === null || v === '') throw new ApiError(400, 'Task deadline is required');
  let d;
  if (typeof v === 'number') d = new Date(v);
  else if (typeof v === 'string') {
    d = /^-?\d+$/.test(v.trim()) ? new Date(Number(v)) : new Date(v);
  } else throw new ApiError(400, 'Task deadline must be a valid date');
  if (isNaN(d.getTime())) throw new ApiError(400, 'Task deadline must be a valid date');
  return d;
}

function parseBool(v, field) {
  if (v === undefined || v === null || v === '') return false;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw new ApiError(400, `${field} must be true or false`);
}

function validateTaskBody(body) {
  body = body || {};
  if (body.name === undefined || body.name === null || body.name === '') {
    throw new ApiError(400, 'Task name is required');
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new ApiError(400, 'Task name must be a non-empty string');
  }
  const deadline = parseDeadline(body.deadline);

  let description = body.description;
  if (description === undefined || description === null) description = '';
  if (typeof description !== 'string') throw new ApiError(400, 'Task description must be a string');

  const completed = parseBool(body.completed, 'completed');

  let assignedUser = body.assignedUser;
  if (assignedUser === undefined || assignedUser === null) assignedUser = '';
  if (typeof assignedUser !== 'string') throw new ApiError(400, 'assignedUser must be a user id string');
  assignedUser = assignedUser.trim();
  if (assignedUser !== '' && !isValidId(assignedUser)) {
    throw new ApiError(400, 'assignedUser is not a valid user id');
  }

  let assignedUserName = body.assignedUserName;
  if (assignedUserName === null || assignedUserName === '') assignedUserName = undefined;
  if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
    throw new ApiError(400, 'assignedUserName must be a string');
  }
  if (assignedUser === '' && assignedUserName !== undefined && assignedUserName !== 'unassigned') {
    throw new ApiError(400, 'assignedUserName given without a matching assignedUser');
  }

  return { name: body.name.trim(), description, deadline, completed, assignedUser, assignedUserName };
}

// Resolve the assigned user (404 if missing, 400 if the name does not match).
async function resolveAssignee(data) {
  if (data.assignedUser === '') {
    data.assignedUserName = 'unassigned';
    return null;
  }
  const user = await User.findById(data.assignedUser);
  if (!user) throw new ApiError(404, 'Assigned user does not exist');
  if (data.assignedUserName !== undefined && data.assignedUserName !== user.name) {
    throw new ApiError(400, 'assignedUserName does not match the assigned user');
  }
  data.assignedUserName = user.name;
  return user;
}

async function syncTaskUser(taskId, oldUserId, data) {
  taskId = String(taskId);
  // Remove from any user other than the new assignee (covers old user + stale refs).
  const others = { pendingTasks: taskId };
  if (data.assignedUser) others._id = { $ne: data.assignedUser };
  await User.updateMany(others, { $pull: { pendingTasks: taskId } });
  if (oldUserId && oldUserId !== data.assignedUser && isValidId(oldUserId)) {
    await User.updateOne({ _id: oldUserId }, { $pull: { pendingTasks: taskId } });
  }
  if (data.assignedUser) {
    const update = data.completed
      ? { $pull: { pendingTasks: taskId } }
      : { $addToSet: { pendingTasks: taskId } };
    await User.updateOne({ _id: data.assignedUser }, update);
  }
}

// --- Routes -----------------------------------------------------------------

router.get('/', handle(async (req, res) => {
  const data = await collectionGet(Task, req.query, 100);
  send(res, 200, 'OK', data);
}));

router.post('/', handle(async (req, res) => {
  const data = validateTaskBody(req.body);
  await resolveAssignee(data);

  const task = new Task(data);
  await task.save();
  await syncTaskUser(task._id, '', data);

  send(res, 201, 'Task created', task);
}));

router.get('/:id', handle(async (req, res) => {
  const task = await getById(Task, req.params.id, req.query, 'Task');
  send(res, 200, 'OK', task);
}));

router.put('/:id', handle(async (req, res) => {
  const id = req.params.id;
  if (!isValidId(id)) throw new ApiError(404, 'Task not found');
  const task = await Task.findById(id);
  if (!task) throw new ApiError(404, 'Task not found');

  const data = validateTaskBody(req.body);
  await resolveAssignee(data);

  const oldUserId = task.assignedUser;
  task.set(data); // dateCreated untouched
  await task.save();
  await syncTaskUser(task._id, oldUserId, data);

  send(res, 200, 'Task updated', task);
}));

router.delete('/:id', handle(async (req, res) => {
  const id = req.params.id;
  if (!isValidId(id)) throw new ApiError(404, 'Task not found');
  const task = await Task.findById(id);
  if (!task) throw new ApiError(404, 'Task not found');

  await User.updateMany({ pendingTasks: id }, { $pull: { pendingTasks: id } });
  await Task.deleteOne({ _id: id });

  send(res, DELETE_STATUS, 'Task deleted', task);
}));

module.exports = router;
