const express = require('express');
const c = require('../controllers/technicianController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

/**
 * `/api/technician` — a technician's own working day. Every handler resolves the Technician
 * behind the session and reads only visits assigned to them (404 otherwise). The phase-4
 * technician app calls exactly these; the portal's /tech workspace calls them today.
 */
const self = express.Router();
self.use(authenticateToken, requireRole('technician'));
self.get('/me', c.getMe);
self.get('/visits', c.myDay);
self.get('/visits/:id', c.getVisit);
self.post('/visits/:id/start', c.start);
self.post('/visits/:id/arrive', c.arrive);
self.post('/visits/:id/verify', c.verify);
self.post('/visits/:id/complete', c.complete);
self.post('/visits/:id/missed', c.missed);
self.post('/visits/:id/location', c.location);
self.get('/specimens', c.mySpecimens);
self.post('/handover', c.handOver);

/** `/api/technicians` — the roster, administrators only. */
const roster = express.Router();
roster.use(authenticateToken, requireRole('admin'));
roster.get('/', c.list);
roster.post('/', c.create);
roster.put('/:id', c.update);

module.exports = { self, roster };
