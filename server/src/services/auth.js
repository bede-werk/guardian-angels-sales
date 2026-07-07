// Password hashing + session token helpers for the auth routes/middleware.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const hashPassword = (plain) => bcrypt.hash(plain, 10);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);
const generateToken = () => crypto.randomBytes(32).toString('hex');

module.exports = { hashPassword, verifyPassword, generateToken };
