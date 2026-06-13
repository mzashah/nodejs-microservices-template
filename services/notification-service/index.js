'use strict';

const express = require('express');
const amqp = require('amqplib');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3003;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const EXCHANGE_NAME = 'user_events';
const QUEUE_NAME = 'notification_queue';

app.use(express.json());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/notifications_db')
  .then(() => console.log('[Notify] MongoDB connected'))
  .catch((err) => console.error('[Notify] MongoDB error:', err.message));

const notificationSchema = new mongoose.Schema({
  type:      { type: String, required: true },
  recipient: { type: String, required: true },
  subject:   { type: String },
  body:      { type: String },
  status:    { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  error:     { type: String },
  event:     { type: Object },
}, { timestamps: true });

notificationSchema.index({ recipient: 1, createdAt: -1 });
const Notification = mongoose.model('Notification', notificationSchema);

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.ethereal.email',
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465',
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendEmail(to, subject, html) {
  return transporter.sendMail({
    from: process.env.EMAIL_FROM || 'no-reply@microservices.app',
    to, subject, html,
  });
}

const TEMPLATES = {
  'user.created': (e) => ({
    subject: 'Welcome to our platform!',
    html: `<h2>Welcome!</h2><p>Your account (${e.email}) was created successfully.</p><p>Thank you for joining us!</p>`,
  }),
  'user.updated': (e) => ({
    subject: 'Your profile was updated',
    html: `<p>Your account (${e.email}) was updated.</p><p>Changed fields: ${(e.changes || []).join(', ')}</p>`,
  }),
  'user.deleted': (e) => ({
    subject: 'Account deactivated',
    html: `<p>Your account (${e.email}) has been deactivated. Contact support if this was a mistake.</p>`,
  }),
};

async function handleEvent(routingKey, event) {
  const template = TEMPLATES[routingKey];
  if (!template) { console.warn(`[Notify] No template for: ${routingKey}`); return; }

  const { subject, html } = template(event);
  const notif = await Notification.create({ type: routingKey, recipient: event.email, subject, body: html, event });

  try {
    await sendEmail(event.email, subject, html);
    await Notification.updateOne({ _id: notif._id }, { status: 'sent' });
    console.log(`[Notify] Sent ${routingKey} to ${event.email}`);
  } catch (err) {
    await Notification.updateOne({ _id: notif._id }, { status: 'failed', error: err.message });
    console.error(`[Notify] Failed ${routingKey}:`, err.message);
  }
}

async function startConsumer() {
  let retries = 0;
  while (retries < 10) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      const ch = await conn.createChannel();
      ch.prefetch(5);
      await ch.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
      const q = await ch.assertQueue(QUEUE_NAME, { durable: true });
      await ch.bindQueue(q.queue, EXCHANGE_NAME, 'user.#');
      console.log('[Notify] Consumer ready');
      ch.consume(q.queue, async (msg) => {
        if (!msg) return;
        try {
          const event = JSON.parse(msg.content.toString());
          await handleEvent(msg.fields.routingKey, event);
          ch.ack(msg);
        } catch (err) {
          console.error('[Notify] Processing error:', err.message);
          ch.nack(msg, false, false);
        }
      });
      conn.on('close', () => { console.warn('[Notify] AMQP closed, reconnecting...'); setTimeout(startConsumer, 5000); });
      return;
    } catch (err) {
      retries++;
      console.warn(`[Notify] RabbitMQ attempt ${retries}:`, err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

startConsumer();

app.get('/health', (req, res) => res.json({ service: 'notification-service', status: 'healthy' }));

app.get('/notifications', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const filter = {};
    if (req.query.recipient) filter.recipient = req.query.recipient;
    if (req.query.status)    filter.status    = req.query.status;
    const [notifications, total] = await Promise.all([
      Notification.find(filter, '-body').sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit),
      Notification.countDocuments(filter),
    ]);
    res.json({ notifications, total, page });
  } catch {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.listen(PORT, () => console.log(`[Notification Service] Running on port ${PORT}`));
module.exports = app;
