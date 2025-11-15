// api-server.js
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const MoodleActivityTracker = require('./moodle-tracker');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// API Routes

// 1. Main API - Upload complete course data (no body required)
app.post('/api/courses/:courseId/upload', async (req, res) => {
  try {
    const { courseId } = req.params;
    const courseIdNum = parseInt(courseId);
    
    console.log(`🚀 Starting data upload for course ${courseIdNum}...`);
    
    // Initialize Moodle tracker
    const moodleTracker = new MoodleActivityTracker(
      process.env.MOODLE_URL,
      process.env.MOODLE_TOKEN
    );

    // Step 1: Get enrolled students
    console.log('📋 Step 1: Fetching students...');
    const students = await moodleTracker.getEnrolledUsers(courseIdNum);
    const studentsData = students.map(student => ({
      id: parseInt(student.id),
      username: student.username,
      firstname: student.firstname,
      lastname: student.lastname,
      fullname: `${student.firstname} ${student.lastname}`,
      email: student.email || "",
      firstaccess: formatTimestamp(student.firstaccess),
      lastaccess: formatTimestamp(student.lastaccess),
      lastcourseaccess: formatTimestamp(student.lastcourseaccess),
      roles: student.roles ? student.roles.map((r) => r.shortname).join(", ") : "student",
      enrolledcourses: student.enrolledcourses ? student.enrolledcourses.length : 0,
    }));

    // Save students
    const { error: studentsError } = await supabase
      .from('students')
      .upsert(studentsData, { onConflict: 'id' });
    if (studentsError) throw studentsError;
    console.log(`✅ Saved ${studentsData.length} students`);

    // Step 2: Get course content
    console.log('📋 Step 2: Fetching course content...');
    const contents = await moodleTracker.getCourseContents(courseIdNum);
    const flatContent = [];
    
    contents.forEach((section) => {
      section.modules.forEach((module) => {
        const item = {};
        item.sectionnumber = section.section;
        item.sectionname = section.name;
        item.sectionvisible = section.visible === 1;
        item.activityid = parseInt(module.id);
        item.activityname = module.name;
        item.activitytype = module.modname;
        item.modplural = module.modplural;
        item.indent = module.indent;
        item.url = module.url || "";
        item.visible = module.visible === 1;
        item.visibleoncoursepage = module.visibleoncoursepage === 1;
        item.uservisible = module.uservisible !== false;
        item.availabilityinfo = module.availabilityinfo || "";
        item.published = module.visible === 1 && module.visibleoncoursepage === 1;
        item.hascompletion = (module.completion || 0) > 0;
        item.completionexpected = module.completionexpected || 0;
        item.completionexpecteddate = formatTimestamp(module.completionexpected);
        item.addeddate = formatTimestamp(module.added);
        item.description = module.description || "";
        
        flatContent.push(item);
      });
    });

    // Save course content
    const { error: contentError } = await supabase
      .from('course_content')
      .upsert(flatContent, { onConflict: 'activityid' });
    if (contentError) throw contentError;
    console.log(`✅ Saved ${flatContent.length} course content items`);

    // Step 3: Get completion data for all students
    console.log('📋 Step 3: Fetching completion data...');
    const completionsData = [];
    
    for (let i = 0; i < students.length; i++) {
      const student = students[i];
      process.stdout.write(`  Processing student ${i + 1}/${students.length}\r`);

      try {
        const studentCompletions = await moodleTracker.getActivitiesCompletion(
          courseIdNum,
          student.id
        );

        // Create completion map
        const completionMap = {};
        for (const comp of studentCompletions.statuses || []) {
          completionMap[comp.cmid] = comp;
        }

        // Match completions with activities
        contents.forEach((section) => {
          section.modules.forEach((module) => {
            const completion = completionMap[module.id] || {};
            
            completionsData.push({
              studentid: parseInt(student.id),
              studentname: `${student.firstname} ${student.lastname}`,
              studentemail: student.email || "",
              sectionnumber: section.section,
              sectionname: section.name,
              activityid: parseInt(module.id),
              activityname: module.name,
              activitytype: module.modname,
              published: module.visible === 1 && module.visibleoncoursepage === 1,
              visible: module.visible === 1,
              hascompletiontracking: (module.completion || 0) > 0,
              completionstate: completion.state || 0,
              completionstatus: getCompletionStatus(completion.state),
              iscompleted: (completion.state || 0) >= 1,
              ispassed: (completion.state || 0) === 2,
              isfailed: (completion.state || 0) === 3,
              completiondate: formatTimestamp(completion.timecompleted),
              trackingtype: getTrackingType(completion.tracking),
              overriddenby: completion.overrideby,
            });
          });
        });
      } catch (error) {
        console.log(`\n⚠️  Warning: Could not get completions for ${student.fullname}`);
      }
    }
    console.log(''); // New line after progress

    // Save completions in batches
    console.log(`📋 Saving ${completionsData.length} completion records...`);
    const batchSize = 100;
    for (let i = 0; i < completionsData.length; i += batchSize) {
      const batch = completionsData.slice(i, i + batchSize);
      const { error: completionError } = await supabase
        .from('completions')
        .upsert(batch, { onConflict: 'studentid,activityid' });
      if (completionError) throw completionError;
    }
    console.log(`✅ Saved ${completionsData.length} completion records`);

    // Step 4: Calculate and save statistics
    console.log('📋 Step 4: Calculating statistics...');
    
    // Calculate student statistics
    const studentStats = students.map(student => {
      const studentCompletions = completionsData.filter(
        c => c.studentid === parseInt(student.id) && c.hascompletiontracking
      );
      
      const completed = studentCompletions.filter(c => c.iscompleted).length;
      const passed = studentCompletions.filter(c => c.ispassed).length;
      const trackedActivities = flatContent.filter(a => a.hascompletion).length;

      return {
        studentid: parseInt(student.id),
        studentname: `${student.firstname} ${student.lastname}`,
        studentemail: student.email || "",
        firstaccess: formatTimestamp(student.firstaccess),
        lastaccess: formatTimestamp(student.lastaccess),
        lastcourseaccess: formatTimestamp(student.lastcourseaccess),
        roles: student.roles ? student.roles.map((r) => r.shortname).join(", ") : "student",
        totalactivities: trackedActivities,
        activitiescompleted: completed,
        activitiespassed: passed,
        activitiesfailed: studentCompletions.filter(c => c.isfailed).length,
        activitiesremaining: trackedActivities - completed,
        completionpercentage: trackedActivities > 0 ? ((completed / trackedActivities) * 100).toFixed(2) : 0,
        passpercentage: completed > 0 ? ((passed / completed) * 100).toFixed(2) : 0,
        isactive: isStudentActive(student),
        performancelevel: getPerformanceLevel(completed / trackedActivities)
      };
    });

    // Save student statistics
    const { error: studentStatsError } = await supabase
      .from('student_statistics')
      .upsert(studentStats, { onConflict: 'studentid' });
    if (studentStatsError) throw studentStatsError;
    console.log(`✅ Saved ${studentStats.length} student statistics`);

    // Calculate activity statistics
    const activityStats = flatContent.map(activity => {
      const activityCompletions = completionsData.filter(
        c => c.activityid === activity.activityid && c.hascompletiontracking
      );

      const completed = activityCompletions.filter(c => c.iscompleted).length;
      const passed = activityCompletions.filter(c => c.ispassed).length;
      const failed = activityCompletions.filter(c => c.isfailed).length;

      return {
        activityid: activity.activityid,
        activityname: activity.activityname,
        activitytype: activity.activitytype,
        sectionname: activity.sectionname,
        published: activity.published,
        hastracking: activity.hascompletion,
        totalstudents: students.length,
        studentscompleted: completed,
        studentspassed: passed,
        studentsfailed: failed,
        studentsnotstarted: students.length - completed,
        completionrate: students.length > 0 ? ((completed / students.length) * 100).toFixed(2) : 0,
        passrate: completed > 0 ? ((passed / completed) * 100).toFixed(2) : 0,
        addeddate: activity.addeddate,
        expectedcompletiondate: activity.completionexpecteddate
      };
    });

    // Save activity statistics
    const { error: activityStatsError } = await supabase
      .from('activity_statistics')
      .upsert(activityStats, { onConflict: 'activityid' });
    if (activityStatsError) throw activityStatsError;
    console.log(`✅ Saved ${activityStats.length} activity statistics`);

    // Final response
    res.json({
      success: true,
      message: `Course ${courseIdNum} data uploaded successfully`,
      data: {
        students: studentsData.length,
        activities: flatContent.length,
        completions: completionsData.length,
        studentStatistics: studentStats.length,
        activityStatistics: activityStats.length
      },
      course: {
        id: courseIdNum,
        name: contents[0]?.name || `Course ${courseIdNum}`
      }
    });
    
  } catch (error) {
    console.error('❌ API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 2. Simple health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Course Data API is running',
    timestamp: new Date().toISOString()
  });
});

// 3. Get database statistics
app.get('/api/stats', async (req, res) => {
  try {
    const [
      { count: studentCount },
      { count: activityCount },
      { count: completionCount },
      { count: studentStatsCount },
      { count: activityStatsCount }
    ] = await Promise.all([
      supabase.from('students').select('*', { count: 'exact', head: true }),
      supabase.from('course_content').select('*', { count: 'exact', head: true }),
      supabase.from('completions').select('*', { count: 'exact', head: true }),
      supabase.from('student_statistics').select('*', { count: 'exact', head: true }),
      supabase.from('activity_statistics').select('*', { count: 'exact', head: true })
    ]);

    res.json({
      students: studentCount,
      activities: activityCount,
      completions: completionCount,
      studentStatistics: studentStatsCount,
      activityStatistics: activityStatsCount
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper functions
function formatTimestamp(timestamp) {
  if (!timestamp || timestamp === 0) return null;
  return new Date(timestamp * 1000).toISOString().replace("T", " ").substring(0, 19);
}

function getCompletionStatus(state) {
  const statuses = {
    0: "Incomplete",
    1: "Complete",
    2: "Complete (Passed)",
    3: "Complete (Failed)",
  };
  return statuses[state] || "Unknown";
}

function getTrackingType(tracking) {
  const types = {
    0: "None",
    1: "Manual",
    2: "Automatic",
  };
  return types[tracking] || "Unknown";
}

function isStudentActive(student) {
  if (!student.lastcourseaccess) return false;
  const lastAccess = new Date(student.lastcourseaccess);
  const daysSinceAccess = (Date.now() - lastAccess.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceAccess <= 7;
}

function getPerformanceLevel(completionRate) {
  if (completionRate >= 0.9) return "Excellent";
  if (completionRate >= 0.7) return "Good";
  if (completionRate >= 0.5) return "Average";
  if (completionRate >= 0.3) return "Below Average";
  return "Poor";
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Course Data API Server running on port ${PORT}`);
  console.log(`📚 Available endpoints (NO BODY REQUIRED):`);
  console.log(`   POST /api/courses/:courseId/upload  - Upload complete course data`);
  console.log(`   GET  /api/health                    - Health check`);
  console.log(`   GET  /api/stats                     - Get database statistics`);
  console.log(`\n💡 Example: POST http://localhost:${PORT}/api/courses/5/upload`);
});