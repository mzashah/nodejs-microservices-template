'use strict';

const express = require('express');
const mongoose = require('mongoose');
const amqp = require('amqplib');
const { body, param, validationResult } = require('express-validator');

const app = express();
const PORT = process.env.PORT || 3002;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const EXCHANGE_NAME = 'user_events';

app.use(express.json());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/users_db')
  .then(() => console.log('[Users] MongoDB connected'))
  .catch((err) => console.error('[Users] MongoDB error:', err.message));

const userSchema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  firstName: { type: String, required: true, trim: true, maxlength: 50 },
  lastName:  { type: String, required: true, trim: true, maxlength: 50 },
  phone:     { type: String, trim: true },
  avatar:    { type: String },
  bio:       { type: String, maxlength: 500 },
  isActive:  { type: Boolean, default: true },
  preferences: {
    notifications: { type: Boolean, default: true },
    theme: { type: String, enum: ['light', 'dark'], default: 'light' },
  },
}, { timestamps: true });

userSchema.index({ email: 1 });
const User = mongoose.model('User', userSchema);

let channel = null;

async function connectRabbitMQ() {
  let retries = 0;
  while (retries < 10) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
      console.log('[Users] RabbitMQ connected');
      conn.on('close', () => {
        channel = null;
        console.warn('[Users] RabbitMQ closed, reconnecting...');
        setTimeout(connectRabbitMQ, 5000);
      });
      return;
    } catch (err) {
      retries++;
      console.warn(`[Users] RabbitMQ attempt ${retries}:`, err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function publishEvent(routingKey, payload) {
  if (!channel) return;
  const msg = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  channel.publish(EXCHANGE_NAME, routingKey, Buffer.from(msg), { persistent: true });
  console.log(`[Users] Published: ${routingKey}`);
}

connectRabbitMQ();

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(422).json({ errors: errors.array() }); return false; }
  return true;
}

app.get('/health', (req, res) => res.json({ service: 'user-service', status: 'healthy' }));

app.get('/users', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(100, parseInt(req.query.limit || '20', 10));
    const skip  = (page - 1) * limit;
    const [users, total] = await Promise.all([
      User.find({ isActive: true }, '-__v').sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments({ isActive: true }),
    ]);
    res.json({ users, total, page, totalPages: Math.ceil(total / limit) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/users/:id', param('id').isMongoId(), async (req, res) => {
  if (!validate(req, res)) return;
  try {
    const user = await User.findById(req.params.id, '-__v');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/users/:id',
  param('id').isMongoId(),
  body('email').optional().isEmail().normalizeEmail(),
  body('firstName').optional().isLength({ min: 1, max: 50 }),
  body('lastName').optional().isLength({ min: 1, max: 50 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      ['_id', '__v', 'createdAt'].forEach(f => delete req.body[f]);
      const user = await User.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
      if (!user) return res.status(404).json({ error: 'User not found' });
      await publishEvent('user.updated', { userId: user._id, email: user.email, changes: Object.keys(req.body) });
      res.json(user);
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'Email already in use' });
      res.status(500).json({ error: 'Failed to update user' });
    }
  }
);

app.delete('/users/:id', param('id').isMongoId(), async (req, res) => {
  if (!validate(req, res)) return;
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await publishEvent('user.deleted', { userId: user._id, email: user.email });
    res.json({ message: 'User deleted successfully' });
  } catch {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.listen(PORT, () => console.log(`[User Service] Running on port ${PORT}`));
module.exports = app;
