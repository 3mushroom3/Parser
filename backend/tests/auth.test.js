const request = require('supertest');
const { app } = require('../server'); // We need to export app in server.js

describe('Auth API', () => {
  it('should return 400 for missing credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({});
    expect(res.statusCode).toEqual(400);
  });

  it('should return 401 for invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nonexistent', password: 'password' });
    expect(res.statusCode).toEqual(401);
  });
});
