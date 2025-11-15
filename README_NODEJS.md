# 🚀 Moodle Course Completion API - Node.js Implementation

Complete Node.js implementation for fetching course completion data from Moodle LMS.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage Examples](#usage-examples)
- [API Endpoints](#api-endpoints)
- [Files Overview](#files-overview)

---

## 🎯 Quick Start

### Option 1: Simple Script (No Server)

```bash
# 1. Install dependencies
npm install axios

# 2. Update token in moodle_api_nodejs.js
# Replace: API_TOKEN: 'YOUR_TOKEN_HERE'

# 3. Run
node moodle_api_nodejs.js
```

### Option 2: Express.js API Server

```bash
# 1. Install all dependencies
npm install

# 2. Create .env file
cp .env.example .env

# 3. Update .env with your token
MOODLE_TOKEN=your_actual_token_here

# 4. Start server
npm start
```

### Option 3: Browser/Frontend

```html
<!-- Include the client -->
<script src="moodle-client.js"></script>

<script>
  const client = new MoodleAPIClient(
    'http://omkaravidya.online/webservice/rest/server.php',
    'YOUR_TOKEN'
  );
  
  client.generateReport(1).then(report => {
    console.table(report);
  });
</script>
```

---

## 📦 Installation

### Prerequisites

- Node.js >= 14.0.0
- npm or yarn

### Install Dependencies

```bash
npm install
```

This will install:
- `axios` - HTTP client
- `express` - Web server framework
- `cors` - CORS middleware
- `dotenv` - Environment variables
- `nodemon` - Development auto-reload

---

## ⚙️ Configuration

### Get Your Moodle API Token

1. Login to Moodle as admin
2. Navigate to: **Site Administration → Plugins → Web Services → Manage tokens**
3. Click **Add** to create a new token
4. Select user and service
5. Click **Save changes**
6. **Copy the token**

### Environment Variables

Create a `.env` file in the project root:

```env
MOODLE_TOKEN=abc123xyz456your_actual_token
DEFAULT_COURSE_ID=1
PORT=3000
```

---

## 💻 Usage Examples

### Example 1: Simple Script

```javascript
const { 
  generateCompletionReport,
  displayReportTable 
} = require('./moodle_api_nodejs');

async function main() {
  const report = await generateCompletionReport(1);
  displayReportTable(report);
}

main();
```

### Example 2: Express.js Server

```javascript
// Start the server
node server.js

// Then call APIs:
// GET http://localhost:3000/api/courses/1/report
```

### Example 3: Frontend Integration

```javascript
const client = new MoodleAPIClient(
  'http://omkaravidya.online/webservice/rest/server.php',
  process.env.MOODLE_TOKEN
);

// Get enrolled users
const users = await client.getEnrolledUsers(1);

// Generate report
const report = await client.generateReport(1);
```

### Example 4: React Component

```jsx
import React, { useState, useEffect } from 'react';

function CourseReport() {
  const [report, setReport] = useState([]);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    async function fetchReport() {
      try {
        const response = await fetch(
          'http://localhost:3000/api/courses/1/report'
        );
        const data = await response.json();
        setReport(data.students);
      } catch (error) {
        console.error('Error:', error);
      } finally {
        setLoading(false);
      }
    }
    
    fetchReport();
  }, []);
  
  if (loading) return <div>Loading...</div>;
  
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Completion</th>
        </tr>
      </thead>
      <tbody>
        {report.map(student => (
          <tr key={student.userId}>
            <td>{student.fullName}</td>
            <td>{student.email}</td>
            <td>{student.completionPercentage}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

---

## 🔌 API Endpoints

When running the Express server (`node server.js`):

### Health Check
```
GET /health
```

### Get All Courses
```
GET /api/courses
```
Response:
```json
{
  "success": true,
  "count": 5,
  "courses": [...]
}
```

### Get Enrolled Users
```
GET /api/courses/:courseId/users
```
Example: `GET /api/courses/1/users`

Response:
```json
{
  "success": true,
  "courseId": 1,
  "count": 25,
  "users": [
    {
      "id": 3,
      "username": "student1",
      "fullName": "John Doe",
      "email": "john@example.com"
    }
  ]
}
```

### Get User's Course Completion
```
GET /api/courses/:courseId/users/:userId/completion
```
Example: `GET /api/courses/1/users/3/completion`

Response:
```json
{
  "success": true,
  "courseId": 1,
  "userId": 3,
  "isCompleted": true,
  "completions": [...]
}
```

### Get User's Activities Completion
```
GET /api/courses/:courseId/users/:userId/activities
```
Example: `GET /api/courses/1/users/3/activities`

Response:
```json
{
  "success": true,
  "totalActivities": 10,
  "completedActivities": 8,
  "completionPercentage": 80.00,
  "activities": [...]
}
```

### Generate Complete Report
```
GET /api/courses/:courseId/report
```
Example: `GET /api/courses/1/report`

Response:
```json
{
  "success": true,
  "courseId": 1,
  "summary": {
    "totalStudents": 25,
    "completedCourse": 15,
    "inProgress": 10,
    "averageCompletion": 75.5
  },
  "students": [
    {
      "userId": 3,
      "fullName": "John Doe",
      "email": "john@example.com",
      "totalActivities": 10,
      "completedActivities": 8,
      "completionPercentage": 80.00,
      "courseCompleted": false
    }
  ]
}
```

---

## 📁 Files Overview

| File | Purpose |
|------|---------|
| `moodle_api_nodejs.js` | Main script - call APIs and generate reports |
| `server.js` | Express.js API server |
| `moodle-client.js` | Browser-friendly client (no dependencies) |
| `package.json` | Node.js project configuration |
| `.env.example` | Example environment variables |
| `README_NODEJS.md` | This file - complete documentation |

---

## 🔧 Direct Moodle API Calls

### Using cURL

```bash
# Get enrolled users
curl "http://omkaravidya.online/webservice/rest/server.php?wstoken=YOUR_TOKEN&wsfunction=core_enrol_get_enrolled_users&courseid=1&moodlewsrestformat=json"

# Get course completion
curl "http://omkaravidya.online/webservice/rest/server.php?wstoken=YOUR_TOKEN&wsfunction=core_completion_get_course_completion_status&courseid=1&userid=3&moodlewsrestformat=json"

# Get activities
curl "http://omkaravidya.online/webservice/rest/server.php?wstoken=YOUR_TOKEN&wsfunction=core_completion_get_activities_completion_status&courseid=1&userid=3&moodlewsrestformat=json"
```

### Using fetch (Browser/Node.js)

```javascript
const MOODLE_URL = 'http://omkaravidya.online/webservice/rest/server.php';
const TOKEN = 'your_token';

// Get users
const response = await fetch(
  `${MOODLE_URL}?wstoken=${TOKEN}&wsfunction=core_enrol_get_enrolled_users&courseid=1&moodlewsrestformat=json`
);
const users = await response.json();
```

### Using axios (Node.js)

```javascript
const axios = require('axios');

const response = await axios.get(
  'http://omkaravidya.online/webservice/rest/server.php',
  {
    params: {
      wstoken: 'your_token',
      wsfunction: 'core_enrol_get_enrolled_users',
      courseid: 1,
      moodlewsrestformat: 'json'
    }
  }
);

const users = response.data;
```

---

## 📊 Expected Output

```
================================================================================
COURSE COMPLETION REPORT TABLE
================================================================================
User ID   Username      Full Name               Total   Complete  %         Course Done
----------------------------------------------------------------------------------
3         student1      John Doe                10      8         80.00%    ❌ No
4         student2      Jane Smith              10      10        100.00%   ✅ Yes
5         student3      Bob Johnson             10      5         50.00%    ❌ No
================================================================================

📊 SUMMARY STATISTICS:
   Total Students: 3
   Completed Course: 1
   In Progress: 2
   Average Completion: 76.67%

✅ Report exported to: moodle_completion_report.json
✅ Report exported to: moodle_completion_report.csv
```

---

## 🐛 Troubleshooting

### "Invalid token" error
- Verify your token is correct
- Check web services are enabled in Moodle
- Ensure user has appropriate permissions

### "Function not available" error
- Add the function to your web service
- Go to: Site Administration → Plugins → Web Services → External services

### CORS errors (browser)
- Use the Express.js server as a proxy
- Or enable CORS in Moodle

### Connection timeout
- Check Moodle server is accessible
- Verify firewall settings
- Increase timeout in axios config

---

## 🎉 You're Ready!

Start the server and call the APIs:

```bash
npm start
```

Then visit:
```
http://localhost:3000/api/courses/1/report
```

Happy coding! 🚀
