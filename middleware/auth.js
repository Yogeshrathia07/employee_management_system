const jwt = require('jsonwebtoken');
const { User } = require('../models');

const auth = async (req, res, next) => {
  try {
    let token = req.headers.authorization;
    if (token && token.startsWith('Bearer ')) {
      token = token.slice(7);
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id, { attributes: { exclude: ['password'] } });
    if (!user) return res.status(401).json({ message: 'User not found' });
    if (user.role === 'superadmin' && user.status === 'inactive') {
      user.status = 'active';
      await user.save();
    }
    if (user.status === 'inactive') return res.status(403).json({ message: 'Account is inactive' });

    req.user = user;

    const requiresDocLock =
      user.role === 'employee' &&
      ['pending_docs', 'docs_submitted'].includes(user.verificationStatus);

    if (requiresDocLock) {
      const allowedPrefixes = [
        '/auth/login',
        '/users/me',
        '/users/me/profile',
        '/users/change-password',
        '/users/me/photo',
        '/documents',
      ];

      const currentPath = req.path || '';
      const isAllowed = allowedPrefixes.some(prefix => currentPath === prefix || currentPath.startsWith(prefix + '/'));

      if (!isAllowed) {
        return res.status(403).json({
          message: 'Document verification required',
          lockPath: '/employee/documents',
          verificationStatus: user.verificationStatus,
        });
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
};

module.exports = { auth, requireRole };
