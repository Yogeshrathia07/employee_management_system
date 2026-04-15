const { Op } = require('sequelize');
const { User, Company, Document } = require('../models');
const bcrypt = require('bcryptjs');
const fs   = require('fs');
const path = require('path');

function isStrongPassword(p) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_\-+=])[A-Za-z\d@$!%*?&#^()_\-+=]{8,}$/.test(p);
}

exports.getUsers = async (req, res) => {
  try {
    const where = {};
    if (req.user.role === 'admin') {
      where.companyId = req.user.companyId;
      where.role = { [Op.in]: ['employee', 'manager'] };
    } else if (req.user.role === 'manager') {
      where.managerId = req.user.id;
    } else if (req.user.role === 'superadmin') {
      if (req.query.companyId) where.companyId = req.query.companyId;
    }

    const users = await User.findAll({
      where,
      attributes: { exclude: ['password'] },
      include: [
        { model: Company, as: 'company', attributes: ['id', 'name'] },
        { model: User, as: 'manager', attributes: ['id', 'name'] },
      ],
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, companyId, managerId, baseSalary,
            basicSalary, da, hra, conveyance, medicalExpenses, specialAllowance, bonus, ta,
            pfApplicable, allowedLeavePerMonth,
            department, phone, position, gender } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Name and email are required' });

    const exists = await User.findOne({ where: { email } });
    if (exists) return res.status(400).json({ message: 'Email already exists' });

    const finalRole = role || 'employee';
    const userData = {
      name, email,
      password: password || 'Employee@123',
      role: finalRole,
      department: department || '',
      phone: phone || '',
      position: position || '',
      gender: gender || 'unspecified',
      verificationStatus: finalRole === 'employee' ? 'pending_docs' : null,
      status: 'active',
    };
    // Salary structure components
    const comp = {
      basicSalary:      parseFloat(basicSalary)      || 0,
      da:               parseFloat(da)               || 0,
      hra:              parseFloat(hra)              || 0,
      conveyance:       parseFloat(conveyance)       || 0,
      medicalExpenses:  parseFloat(medicalExpenses)  || 0,
      specialAllowance: parseFloat(specialAllowance) || 0,
      bonus:            parseFloat(bonus)            || 0,
      ta:               parseFloat(ta)               || 0,
    };
    Object.assign(userData, comp);
    // CTC = sum of all components
    userData.baseSalary = comp.basicSalary + comp.da + comp.hra + comp.conveyance
      + comp.medicalExpenses + comp.specialAllowance + comp.bonus + comp.ta;
    if (pfApplicable !== undefined)         userData.pfApplicable         = pfApplicable;
    if (allowedLeavePerMonth !== undefined) userData.allowedLeavePerMonth = allowedLeavePerMonth;
    if (req.body.currency)                  userData.currency              = req.body.currency;

    if (req.user.role === 'admin') {
      userData.companyId = req.user.companyId;
      if (managerId) userData.managerId = managerId;
    } else if (req.user.role === 'superadmin') {
      userData.companyId = companyId;
      if (managerId) userData.managerId = managerId;
    }

    const user = await User.create(userData);
    const plain = user.toJSON();
    delete plain.password;
    res.status(201).json(plain);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { name, email, role, companyId, managerId, baseSalary,
            basicSalary, da, hra, conveyance, medicalExpenses, specialAllowance, bonus, ta,
            pfApplicable, allowedLeavePerMonth,
            status, department, phone, password, position, gender } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const nextRole = role || user.role;

    if (user.role === 'superadmin' && status && status !== 'active') {
      return res.status(400).json({ message: 'Superadmin cannot be deactivated' });
    }

    if (name)                     user.name       = name;
    if (email)                    user.email      = email;
    if (department !== undefined) user.department = department;
    if (phone !== undefined)      user.phone      = phone;
    if (position !== undefined)   user.position   = position;
    if (gender !== undefined)     user.gender     = gender || 'unspecified';
    if (status)                   user.status     = user.role === 'superadmin' ? 'active' : status;
    // Update salary structure components and recalculate CTC
    const compFields = { basicSalary, da, hra, conveyance, medicalExpenses, specialAllowance, bonus, ta };
    let anyComp = false;
    Object.entries(compFields).forEach(([k, v]) => {
      if (v !== undefined) { user[k] = parseFloat(v) || 0; anyComp = true; }
    });
    if (anyComp) {
      // Recalculate CTC as sum of all components
      user.baseSalary = (user.basicSalary || 0) + (user.da || 0) + (user.hra || 0) + (user.conveyance || 0)
        + (user.medicalExpenses || 0) + (user.specialAllowance || 0) + (user.bonus || 0) + (user.ta || 0);
    }
    if (pfApplicable !== undefined)         user.pfApplicable         = pfApplicable;
    if (allowedLeavePerMonth !== undefined) user.allowedLeavePerMonth = allowedLeavePerMonth;
    if (req.body.currency)                  user.currency              = req.body.currency;
    if (password) {
      if (!isStrongPassword(password)) return res.status(400).json({ message: 'Password must be at least 8 characters with uppercase, lowercase, number and special character' });
      user.password = password;
    }

    if (req.user.role === 'superadmin') {
      if (role)                        user.role      = role;
      if (companyId)                   user.companyId = companyId;
      if (managerId !== undefined)     user.managerId = managerId || null;
    }
    if (req.user.role === 'admin') {
      if (role && ['employee', 'manager'].includes(role)) user.role = role;
      if (managerId !== undefined) user.managerId = managerId || null;
    }

    if (nextRole === 'employee' && !user.verificationStatus) {
      user.verificationStatus = 'pending_docs';
      user.status = 'active';
    }
    if (nextRole !== 'employee' && user.verificationStatus) {
      user.verificationStatus = null;
    }

    await user.save();
    const plain = user.toJSON();
    delete plain.password;
    res.json(plain);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /users/:id/verify — admin/manager approves employee after doc review
exports.verifyEmployee = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { action, note } = req.body; // action: 'approve' | 'reject'
    if (action === 'approve') {
      user.verificationStatus = 'verified';
      user.status = 'active';
    } else if (action === 'reject') {
      user.verificationStatus = 'pending_docs';
      // Keep active so employee can log in and re-upload documents
      user.status = 'active';
    } else {
      return res.status(400).json({ message: 'action must be approve or reject' });
    }
    await user.save();
    const plain = user.toJSON(); delete plain.password;
    res.json(plain);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === 'superadmin') return res.status(400).json({ message: 'Superadmin cannot be deleted' });
    
    // Move to recycle bin
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('user', user.id, req.user, user.toJSON(), user.name + ' (' + user.email + ')');
    
    await user.destroy();
    res.json({ message: 'User deleted (moved to recycle bin for 30 days)' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getMe = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password'] },
      include: [
        { model: Company, as: 'company', attributes: ['id', 'name', 'logoUrl'] },
        { model: User, as: 'manager', attributes: ['id', 'name'] },
      ],
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /users/me/profile — employee updates own profile (limited fields)
exports.updateMyProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { name, phone, profilePhoto, gender } = req.body;
    if (name) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (profilePhoto !== undefined) user.profilePhoto = profilePhoto;
    if (gender !== undefined) user.gender = gender || 'unspecified';

    await user.save();
    const plain = user.toJSON();
    delete plain.password;
    res.json(plain);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /users/change-password — employee changes own password
exports.changeOwnPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Current and new password are required' });
    if (!isStrongPassword(newPassword)) return res.status(400).json({ message: 'Password must be at least 8 characters with uppercase, lowercase, number and special character' });

    const user = await User.findByPk(req.user.id);
    const match = await user.comparePassword(currentPassword);
    if (!match) return res.status(400).json({ message: 'Current password is incorrect' });

    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /users/:id/reset-password — admin/superadmin resets any user's password
exports.resetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ message: 'New password is required' });
    if (!isStrongPassword(newPassword)) return res.status(400).json({ message: 'Password must be at least 8 characters with uppercase, lowercase, number and special character' });

    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /users/:id/details — admin/superadmin view full employee details
exports.getUserDetails = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: { exclude: ['password'] },
      include: [
        { model: Company, as: 'company', attributes: ['id', 'name'] },
        { model: User, as: 'manager', attributes: ['id', 'name'] },
      ],
    });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /users/me/photo — upload profile photo
exports.uploadPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Delete old photo file if exists
    if (user.profilePhoto) {
      const oldPath = path.join(__dirname, '..', 'uploads', 'photos', user.profilePhoto);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    user.profilePhoto = req.file.filename;
    await user.save();
    res.json({ message: 'Photo uploaded', profilePhoto: req.file.filename });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /users/:id/photo — serve profile photo
exports.getPhoto = async (req, res) => {
  try {

    const user = await User.findByPk(req.params.id, { attributes: ['profilePhoto'] });
    if (!user || !user.profilePhoto) return res.status(404).json({ message: 'No photo' });
    const filePath = path.join(__dirname, '..', 'uploads', 'photos', user.profilePhoto);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found' });
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
