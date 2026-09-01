// Password hashing + session token helpers for the auth routes/middleware.
// Keeping these tiny wrappers in one file means routes/auth.js and
// middleware/requireAuth.js never touch bcrypt/crypto directly.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// One-way hash a plaintext password for storage (users.password_hash).
// The "10" is bcrypt's cost factor - higher is slower but harder to brute-force.
const hashPassword = (plain) => bcrypt.hash(plain, 10);

// Check a plaintext password attempt against a stored hash. Returns true/false.
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// A random, unguessable session token issued at login and stored as a row in
// `sessions` (one per device). Whoever presents this token in an Authorization
// header is treated as that session's user (see middleware/requireAuth.js).
const generateToken = () => crypto.randomBytes(32).toString('hex');

module.exports = { hashPassword, verifyPassword, generateToken };
