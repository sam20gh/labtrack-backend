const express = require('express');
const c = require('../controllers/labController');

/**
 * `/api/labs/:lab/*` — the laboratories' API. No token: every request is signed with the lab's
 * own secret, and the signature is over the exact bytes sent, so this router reads the **raw**
 * body and is mounted in index.js *before* `express.json()` — the arrangement the Stripe webhook
 * needs for the same reason. See `controllers/labController.js`.
 */
const router = express.Router();
const raw = express.raw({ type: 'application/json', limit: '5mb' });

router.post('/:lab/events', raw, c.events);
router.post('/:lab/results', raw, c.results);

module.exports = router;
