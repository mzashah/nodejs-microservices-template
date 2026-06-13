'use strict';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const morgan = require('morgan');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => console.log('[Gateway] Redis connected'));
redis.on('error', (err) => console.error('[Gateway] Redis error:', err.message));

app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(morgan('[:date[clf]] :method :url :status :response-time ms'));
app.use(express.json({ limit: '10mb' }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});

app.use(globalLimiter);

const PUBLIC_PATHS = [
  { method: 'POST', path: '/api/auth/register' },
  { method: 'POST', path: '/api/auth/login' },
  { method: 'GET',  path: '/health' },
];

async function verifyJWT(req, res, next) {
  const isPublic = PUBLIC_PATHS.some(
    (p) => p.method === req.method && req.path.startsWith(p.path)
  );
  if (isPublic) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  try {
    const isBlacklisted = await redis.get(`blacklist:${token}`);
    if (isBlacklisted) return res.status(401).json({ error: 'Token has been revoked' });

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.headers['x-user-id'] = decoded.userId;
    req.headers['x-user-email'] = decoded.email;
    req.headers['x-user-role'] = decoded.role || 'user';
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.use(verifyJWT);

app.get('/health', (req, res) => {
  res.json({
    service: 'api-gateway',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const USER_URL = process.env.USER_SERVICE_URL || 'http://localhost:3002';

function proxyOpts(target, pathRewrite) {
  return {
    target,
    changeOrigin: true,
    pathRewrite,
    on: {
      error: (err, req, res) => {
        console.error(`[Gateway] Proxy error for ${req.path}:`, err.message);
        res.status(502).json({ error: 'Service temporarily unavailable' });
      },
    },
  };
}

app.use('/api/auth', authLimiter, createProxyMiddleware(proxyOpts(AUTH_URL, { '^/api/auth': '' })));
app.use('/api/users', createProxyMiddleware(proxyOpts(USER_URL, { '^/api/users': '/users' })));

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));

app.use((err, req, res, _next) => {
  console.error('[Gateway] Error:', err);
  res.status(500).json({ error: 'Internal gateway error' });
});

app.listen(PORT, () => {
  console.log(`[API Gateway] Running on port ${PORT}`);
  console.log(`[API Gateway] Auth: ${AUTH_URL} | Users: ${USER_URL}`);
});

module.exports = app;
