const jwt = require('jsonwebtoken');
const { User, Company } = require('../models');

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({
      where: { email },
      include: [{ model: Company, as: 'company' }],
    });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });
    if (user.role === 'superadmin' && user.status === 'inactive') {
      user.status = 'active';
      await user.save();
    }
    if (user.status === 'inactive') return res.status(403).json({ message: 'Account is inactive. Contact your administrator.' });
    // Block employees/managers who have not yet completed document verification
    if (['employee', 'manager'].includes(user.role) && user.verificationStatus === 'pending_docs') {
      return res.status(403).json({ message: 'Your account is pending document verification. Please upload your required documents and await admin approval.' });
    }
    if (['employee', 'manager'].includes(user.role) && user.verificationStatus === 'docs_submitted') {
      return res.status(403).json({ message: 'Your documents are under review. You will be notified once your account is approved.' });
    }

    const match = await user.comparePassword(password);
    if (!match) return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        companyId: user.companyId,
        company: user.company,
        baseSalary: user.baseSalary,
        profilePhoto: user.profilePhoto,
        position: user.position || '',
        department: user.department || '',
        gender: user.gender || 'unspecified',
        employeeCode: user.employeeCode || '',
        verificationStatus: user.verificationStatus,
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
