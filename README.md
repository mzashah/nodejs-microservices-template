# Node.js Microservices Template

Production-ready microservices architecture with Node.js, Docker, RabbitMQ, Redis, MongoDB, and Nginx.

## Architecture

```
                        +---------------------------------------------+
                        |                   NGINX                      |
                        |            (Reverse Proxy :80)               |
                        +-------------------+--------------------------+
                                            |
                        +-------------------v--------------------------+
                        |              API Gateway :3000               |
                        |   JWT Verify | Rate Limit | Request Log      |
                        +----+-----------------------------+-----------+
                             |                             |
               +-------------v----------+    +------------v----------+
               |   Auth Service :3001   |    |  User Service :3002   |
               |  Register/Login/Verify |    |   CRUD Operations     |
               +------------------------+    +-----------+-----------+
                             |                           |
               +-------------v---------------------------v-----------+
               |                   RabbitMQ :5672                    |
               |              Message Broker / Event Bus             |
               +------------------------------+----------------------+
                                              |
                        +---------------------v------------------+
                        |   Notification Service :3003           |
                        |   Email / Push Notifications           |
                        +----------------------------------------+
```

## Services

| Service              | Port  | Description                          |
|----------------------|-------|--------------------------------------|
| API Gateway          | 3000  | Reverse proxy, JWT auth, rate limit  |
| Auth Service         | 3001  | Registration, login, token mgmt      |
| User Service         | 3002  | User CRUD + RabbitMQ events          |
| Notification Service | 3003  | Email/push via RabbitMQ consumer     |
| RabbitMQ             | 5672  | Message broker (mgmt: 15672)         |
| Redis                | 6379  | Token blacklist, caching             |
| MongoDB              | 27017 | Primary data store                   |
| Nginx                | 80    | Reverse proxy / load balancer        |

## Tech Stack

- **Runtime:** Node.js 20 LTS
- **Framework:** Express.js 4.x
- **Messaging:** RabbitMQ 3.x with amqplib
- **Cache:** Redis 7.x with ioredis
- **Database:** MongoDB 7.x with Mongoose
- **Auth:** JWT (jsonwebtoken) + bcrypt
- **Proxy:** Nginx 1.25
- **Container:** Docker 24+ / Docker Compose v2

## Quick Start

### Prerequisites
- Docker 24+ and Docker Compose v2
- Node.js 20+ (for local dev)

### Run with Docker Compose

```bash
git clone https://github.com/mzashah/nodejs-microservices-template
cd nodejs-microservices-template
cp .env.example .env
docker compose up --build
```

### Local Development

```bash
npm install
npm run dev:gateway    # Start API Gateway
npm run dev:auth       # Start Auth Service
npm run dev:users      # Start User Service
npm run dev:notify     # Start Notification Service
```

## API Endpoints

### Auth Service (via Gateway)
```
POST /api/auth/register   - Create account
POST /api/auth/login      - Get JWT token
POST /api/auth/logout     - Invalidate token
GET  /api/auth/verify     - Verify token validity
```

### User Service (via Gateway)
```
GET    /api/users         - List all users
GET    /api/users/:id     - Get user by ID
PUT    /api/users/:id     - Update user
DELETE /api/users/:id     - Delete user
```

## RabbitMQ Events

| Event               | Producer     | Consumer             |
|---------------------|--------------|----------------------|
| user.created        | User Service | Notification Service |
| user.updated        | User Service | Notification Service |
| user.deleted        | User Service | Notification Service |

## Monitoring

- RabbitMQ Management UI: http://localhost:15672 (guest/guest)
- API Gateway health: http://localhost:3000/health

## License

MIT
