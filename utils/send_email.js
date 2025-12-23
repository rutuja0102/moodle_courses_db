// ============================================================================
// EMAIL CONFIGURATION & UTILITIES
// ============================================================================
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// SEND EMAIL
async function sendEmail({ to, subject, html, text }) {
  try {
    const mailOptions = {
      from: `"OMKARVIDYA Alert System" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),
    };

    const info = await emailTransporter.sendMail(mailOptions);
    console.log(`✓ Email sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`✗ Email send failed to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

// LOAD TEMPLATE FUNCTION
function loadTemplate(templateName, variables) {
  try {
    const templatePath = path.join(__dirname, 'templates', `${templateName}.html`);
    let template = fs.readFileSync(templatePath, 'utf8');
    
    // Replace all variables
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      template = template.replace(regex, variables[key]);
    });
    
    // Remove any unreplaced variables
    template = template.replace(/\{\{.*?\}\}/g, '');
    
    return template;
  } catch (error) {
    console.error(`Error loading template ${templateName}:`, error.message);
    return `<h1>Template Error</h1><p>Could not load template: ${templateName}</p>`;
  }
}

// LOW ACTIVITY EMAIL TEMPLATE
function generateLowAttendanceEmail(studentName, courseName, completionRate, month, year) {
  return loadTemplate('low-attendance-email', {
    studentName: studentName || 'Student',
    courseName: courseName || 'Course',
    completionRate: completionRate || '0',
    month: month || 'N/A',
    year: year || 'N/A',
    moodleUrl: process.env.MOODLE_URL || 'https://omkarvidya.in',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@omkarvidya.in',
    currentDate: new Date().toLocaleDateString('en-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'Asia/Kolkata'
    })
  });
}

// COURSE INACTIVITY EMAIL TEMPLATE
function generateInactivityWarningEmail(courseName, lastActivityDate, adminEmails) {
  const lastActivity = lastActivityDate ? new Date(lastActivityDate) : null;
  const now = new Date();
  const inactiveMonths = 3; // Default
  
  let daysSinceActivity = 'N/A';
  let daysToArchival = 90;
  
  if (lastActivity) {
    const diffTime = Math.abs(now - lastActivity);
    daysSinceActivity = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    daysToArchival = Math.max(0, 180 - daysSinceActivity); // 6 months total
  }
  
  return loadTemplate('inactivity-warning-email', {
    courseName: courseName || 'Unknown Course',
    lastActivityDate: lastActivityDate || 'Never',
    daysSinceActivity: daysSinceActivity,
    inactiveMonths: inactiveMonths,
    daysToArchival: daysToArchival,
    adminEmails: Array.isArray(adminEmails) ? adminEmails.join(', ') : adminEmails,
    adminPanelUrl: process.env.ADMIN_PANEL_URL || 'https://omkarvidya.in/admin',
    analyticsUrl: process.env.ANALYTICS_URL || 'https://omkarvidya.in/analytics',
    decisionFormUrl: process.env.DECISION_FORM_URL || 'https://omkarvidya.in/forms/archival',
    currentDate: now.toLocaleDateString('en-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata'
    })
  });
}

// TEST EMAIL FUNCTION (for debugging)
async function sendTestEmail(to) {
  const testHtml = loadTemplate('low-attendance-email', {
    studentName: 'Test Student',
    courseName: 'Computer Science 101',
    completionRate: '65.5',
    month: 'November',
    year: '2024',
    moodleUrl: 'https://omkarvidya.in',
    supportEmail: 'support@omkarvidya.in',
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
  });

  return await sendEmail({
    to,
    subject: 'TEST: OMKARVIDYA Low Course Activity Alert',
    html: testHtml,
  });
}

// Export functions
module.exports = {
  sendEmail,
  generateLowAttendanceEmail,
  generateInactivityWarningEmail,
  sendTestEmail
};