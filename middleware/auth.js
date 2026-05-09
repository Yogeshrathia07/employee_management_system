const jwt = require('jsonwebtoken');
const { User } = require('../models');

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return acc;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key) acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function getRequestCookies(req) {
  if (!req.cookies || typeof req.cookies !== 'object') {
    req.cookies = parseCookies(req.headers && req.headers.cookie);
  }
  return req.cookies;
}

function getTokenFromRequest(req) {
  let token = req.headers.authorization;
  if (token && token.startsWith('Bearer ')) return token.slice(7);

  const cookies = getRequestCookies(req);
  if (cookies.token) return cookies.token;
  if (req.query && req.query.token) return req.query.token;
  return null;
}

function getAuthCookieOptions(req) {
  const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
  return {
    path: '/',
    sameSite: 'lax',
    secure: isSecure,
  };
}

function setAuthCookie(res, req, token) {
  res.cookie('token', token, getAuthCookieOptions(req));
}

function clearAuthCookie(res, req) {
  res.clearCookie('token', getAuthCookieOptions(req));
}

function getDocumentLockPath(user) {
  const locked = user && user.role === 'employee' && ['pending_docs', 'docs_submitted'].includes(user.verificationStatus);
  return locked ? '/employee/documents' : '';
}

function getRoleHomePath(user) {
  if (!user) return '/login';
  const paths = {
    superadmin: '/superadmin/dashboard',
    admin: '/admin/dashboard',
    manager: '/manager/dashboard',
    employee: '/employee/dashboard',
  };
  return getDocumentLockPath(user) || paths[user.role] || '/employee/dashboard';
}

function isAllowedDocumentLockPath(currentPath) {
  const allowedPrefixes = [
    '/auth/login',
    '/users/me',
    '/users/me/profile',
    '/users/change-password',
    '/users/me/photo',
    '/documents',
    '/employee/documents',
  ];
  return allowedPrefixes.some(prefix => currentPath === prefix || currentPath.startsWith(prefix + '/'));
}

async function authenticateRequest(req) {
  const token = getTokenFromRequest(req);
  if (!token) {
    const err = new Error('No token provided');
    err.status = 401;
    throw err;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (verifyErr) {
    const err = new Error('Invalid token');
    err.status = 401;
    throw err;
  }

  const user = await User.findByPk(decoded.id, { attributes: { exclude: ['password'] } });
  if (!user) {
    const err = new Error('User not found');
    err.status = 401;
    throw err;
  }

  if (user.role === 'superadmin' && user.status === 'inactive') {
    user.status = 'active';
    await user.save();
  }
  if (user.status === 'inactive') {
    const err = new Error('Account is inactive');
    err.status = 403;
    throw err;
  }

  return user;
}

const auth = async (req, res, next) => {
  try {
    const user = await authenticateRequest(req);
    req.user = user;

    const currentPath = req.path || '';
    const lockPath = getDocumentLockPath(user);
    if (lockPath && !isAllowedDocumentLockPath(currentPath)) {
      return res.status(403).json({
        message: 'Document verification required',
        lockPath,
        verificationStatus: user.verificationStatus,
      });
    }

    next();
  } catch (err) {
    return res.status(err.status || 401).json({ message: err.message || 'Invalid token' });
  }
};

const pageAuth = (...roles) => async (req, res, next) => {
  try {
    const user = await authenticateRequest(req);
    req.user = user;

    const currentPath = (req.baseUrl || '') + (req.path || '');
    const lockPath = getDocumentLockPath(user);
    if (lockPath && !isAllowedDocumentLockPath(currentPath)) {
      return res.redirect(lockPath);
    }
    if (roles.length && !roles.includes(user.role)) {
      return res.redirect(getRoleHomePath(user));
    }

    next();
  } catch (err) {
    clearAuthCookie(res, req);
    return res.redirect('/login');
  }
};

const redirectAuthenticatedUser = async (req, res, next) => {
  try {
    const user = await authenticateRequest(req);
    req.user = user;
    return res.redirect(getRoleHomePath(user));
  } catch (err) {
    clearAuthCookie(res, req);
    next();
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
};

module.exports = {
  auth,
  clearAuthCookie,
  getAuthCookieOptions,
  getRoleHomePath,
  pageAuth,
  redirectAuthenticatedUser,
  requireRole,
  setAuthCookie,
};
