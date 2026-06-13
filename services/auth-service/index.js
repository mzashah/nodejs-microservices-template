'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

app.use(express.json());

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => Math.min(times * 100, 3000),
});
redis.on('connect', () => console.log('[Auth] Redis connected'));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/auth_db')
  .then(() => console.log('[Auth] MongoDB connected'))
  .catch((err) => console.error('[Auth] MongoDB error:', err.message));

const userSchema = new mongoose.Schema({
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:   { type: String, required: true, minlength: 8 },
  role:       { type: String, enum: ['user', 'admin'], default: 'user' },
  isActive:   { type: Boolean, default: true },
  lastLogin:  { type: Date },
  loginCount: { type: Number, default: 0 },
}, { timestamps: true });

userSchema.index({ email: 1 });
const User = mongoose.model('User', userSchema);

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, issuer: 'auth-service' });
}

function respondError(res, status, message) {
  return res.status(status).json({ error: message });
}

app.get('/health', (req, res) => res.json({ service: 'auth-service', status: 'healthy' }));

app.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const existing = await User.findOne({ email });
      if (existing) return respondError(res, 409, 'Email already registered');

      const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await User.create({ email, password: hashed });

      const token = signToken({ userId: user._id, email: user.email, role: user.role });
      res.status(201).json({
        message: 'Registration successful',
        token,
        user: { id: user._id, email: user.email, role: user.role },
      });
    } catch (err) {
      console.error('[Auth] Register error:', err.message);
      respondError(res, 500, 'Registration failed');
    }
  }
);

app.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const user = await User.findOne({ email });
      if (!user || !user.isActive) return respondError(res, 401, 'Invalid credentials');

      const match = await bcrypt.compare(password, user.password);
      if (!match) return respondError(res, 401, 'Invalid credentials');

      await User.updateOne({ _id: user._id }, { $inc: { loginCount: 1 }, lastLogin: new Date() });
      const token = signToken({ userId: user._id, email: user.email, role: user.role });
      res.json({ message: 'Login successful', token, user: { id: user._id, email: user.email, role: user.role } });
    } catch (err) {
      console.error('[Auth] Login error:', err.message);
      respondError(res, 500, 'Login failed');
    }
  }
);

app.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return respondError(res, 400, 'No token provided');

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) await redis.setex(`blacklist:${token}`, ttl, '1');
    res.json({ message: 'Logged out successfully' });
  } catch {
    res.json({ message: 'Token already invalid' });
  }
});

app.get('/verify', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return respondError(res, 401, 'No token');

  const token = authHeader.slice(7);
  try {
    const isBlacklisted = await redis.get(`blacklist:${token}`);
    if (isBlacklisted) return respondError(res, 401, 'Token revoked');

    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, user: { userId: decoded.userId, email: decoded.email, role: decoded.role } });
  } catch (err) {
    respondError(res, 401, err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
  }
});

app.listen(PORT, () => console.log(`[Auth Service] Running on port ${PORT}`));
module.exports = app;
