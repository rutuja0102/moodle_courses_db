// api-server.js
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const MoodleActivityTracker = require('./moodle-tracker');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORRECT: Initialize app FIRST, then use CORS
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001', 
    'http://localhost:5173',
    'http://localhost:5174' // Optional: from environment variable
  ].filter(Boolean), // Remove any undefined values
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Add express.json() middleware
app.use(express.json());

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

// Add these after your existing API routes in api-server.js

// 6. Get all students with complete data
app.get('/api/students', async (req, res) => {
  try {
    const { page = 1, limit = 50, active_only } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    console.log('📚 Fetching all students data...');

    // Step 1: Get all students with pagination
    console.log('📋 Step 1: Fetching students...');
    let studentsQuery = supabase
      .from('students')
      .select('*')
      .order('lastaccess', { ascending: false })
      .range(offset, offset + limitNum - 1);

    const { data: students, error: studentsError, count } = await studentsQuery;
    if (studentsError) throw studentsError;

    // Step 2: Get statistics for all students
    console.log('📋 Step 2: Fetching student statistics...');
    const studentIds = students.map(s => s.id);
    
    const { data: studentStats, error: statsError } = await supabase
      .from('student_statistics')
      .select('*')
      .in('studentid', studentIds);

    if (statsError) throw statsError;

    // Create statistics map
    const statsMap = {};
    studentStats.forEach(stat => {
      statsMap[stat.studentid] = stat;
    });

    // Step 3: Get recent completions for activity context
    console.log('📋 Step 3: Fetching recent completions...');
    const { data: recentCompletions, error: completionsError } = await supabase
      .from('completions')
      .select('studentid, completiondate, activityname')
      .in('studentid', studentIds)
      .not('completiondate', 'is', null)
      .order('completiondate', { ascending: false })
      .limit(500); // Limit to recent completions

    if (completionsError) throw completionsError;

    // Group recent completions by student
    const recentCompletionsMap = {};
    recentCompletions.forEach(comp => {
      if (!recentCompletionsMap[comp.studentid]) {
        recentCompletionsMap[comp.studentid] = [];
      }
      if (recentCompletionsMap[comp.studentid].length < 5) { // Max 5 recent activities per student
        recentCompletionsMap[comp.studentid].push({
          activityName: comp.activityname,
          completionDate: comp.completiondate
        });
      }
    });

    // Step 4: Combine all data
    console.log('📋 Step 4: Combining data...');
    const studentsWithData = students.map(student => {
      const statistics = statsMap[student.id] || {};
      const recentActivities = recentCompletionsMap[student.id] || [];
      
      // Calculate activity status
      const isActive = student.lastaccess ? 
        (Date.now() - new Date(student.lastaccess).getTime()) / (1000 * 60 * 60 * 24) <= 7 : false;

      return {
        id: student.id,
        username: student.username,
        firstname: student.firstname,
        lastname: student.lastname,
        fullname: student.fullname,
        email: student.email,
        roles: student.roles,
        firstAccess: student.firstaccess,
        lastAccess: student.lastaccess,
        lastCourseAccess: student.lastcourseaccess,
        enrolledCourses: student.enrolledcourses,
        isActive: isActive,
        statistics: {
          totalActivities: statistics.totalactivities || 0,
          activitiesCompleted: statistics.activitiescompleted || 0,
          activitiesPassed: statistics.activitiespassed || 0,
          activitiesFailed: statistics.activitiesfailed || 0,
          completionPercentage: statistics.completionpercentage || 0,
          passPercentage: statistics.passpercentage || 0,
          performanceLevel: statistics.performancelevel || 'Unknown'
        },
        recentActivities: recentActivities,
        lastActivity: recentActivities.length > 0 ? recentActivities[0].completionDate : null
      };
    });

    // Apply active_only filter if requested
    let filteredStudents = studentsWithData;
    if (active_only === 'true') {
      filteredStudents = studentsWithData.filter(student => student.isActive);
    }

    // Step 5: Prepare response with pagination info
    const response = {
      success: true,
      data: {
        students: filteredStudents,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limitNum),
          showing: filteredStudents.length
        },
        summary: {
          totalStudents: filteredStudents.length,
          activeStudents: filteredStudents.filter(s => s.isActive).length,
          averageCompletion: filteredStudents.length > 0 ? 
            (filteredStudents.reduce((sum, student) => sum + (student.statistics.completionPercentage || 0), 0) / filteredStudents.length).toFixed(2) : 0,
          topPerformer: filteredStudents.length > 0 ? 
            filteredStudents.reduce((top, current) => 
              (current.statistics.completionPercentage > (top?.statistics.completionPercentage || 0) ? current : top)
            ) : null
        }
      }
    };

    console.log(`✅ Retrieved ${filteredStudents.length} students`);
    res.json(response);
    
  } catch (error) {
    console.error('❌ API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 7. Get all enrolled students with course details
// 7. Get all enrolled students with course details - CORRECTED VERSION
app.get('/api/enrollments', async (req, res) => {
  try {
    const { course, status, performance } = req.query;
    
    console.log('📚 Fetching all enrolled students with course details...');

    // Step 1: Get all students with their statistics
    console.log('📋 Step 1: Fetching students and statistics...');
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select('*')
      .order('lastaccess', { ascending: false });

    if (studentsError) throw studentsError;

    const studentIds = students.map(s => s.id);

    // Step 2: Get all student statistics
    const { data: studentStats, error: statsError } = await supabase
      .from('student_statistics')
      .select('*')
      .in('studentid', studentIds);

    if (statsError) throw statsError;

    const statsMap = {};
    studentStats.forEach(stat => {
      statsMap[stat.studentid] = stat;
    });

    // Step 3: Get course completion data
    console.log('📋 Step 2: Fetching course completion data...');
    const { data: completions, error: completionsError } = await supabase
      .from('completions')
      .select('studentid, sectionname, sectionnumber, activityname, activitytype, iscompleted, completiondate')
      .in('studentid', studentIds);

    if (completionsError) throw completionsError;

    // Step 4: Organize completions by student and course
    console.log('📋 Step 3: Organizing course data...');
    const studentCourses = {};

    completions.forEach(comp => {
      const studentId = comp.studentid;
      const courseName = comp.sectionname || 'Uncategorized';
      
      if (!studentCourses[studentId]) {
        studentCourses[studentId] = {};
      }
      
      if (!studentCourses[studentId][courseName]) {
        studentCourses[studentId][courseName] = {
          courseName: courseName,
          sectionNumber: comp.sectionnumber,
          totalActivities: 0,
          completedActivities: 0,
          activities: []
        };
      }
      
      studentCourses[studentId][courseName].totalActivities++;
      if (comp.iscompleted) {
        studentCourses[studentId][courseName].completedActivities++;
      }
      
      studentCourses[studentId][courseName].activities.push({
        activityName: comp.activityname,
        activityType: comp.activitytype,
        isCompleted: comp.iscompleted,
        completionDate: comp.completiondate
      });
    });

    // Step 5: Combine all data with CORRECTED LOGIC
    console.log('📋 Step 4: Combining enrollment data...');
    const enrollments = students.map(student => {
      const statistics = statsMap[student.id] || {};
      const courses = studentCourses[student.id] ? Object.values(studentCourses[student.id]) : [];
      
      const isActive = student.lastaccess ? 
        (Date.now() - new Date(student.lastaccess).getTime()) / (1000 * 60 * 60 * 24) <= 7 : false;

      const performanceLevel = statistics.performancelevel || 'Unknown';

      // CORRECTED: Calculate favorite course based on completion percentage
      let favoriteCourse = 'None';
      if (courses.length > 0) {
        const coursesWithCompletion = courses.filter(course => course.totalActivities > 0);
        if (coursesWithCompletion.length > 0) {
          // Find course with highest completion percentage
          favoriteCourse = coursesWithCompletion.reduce((fav, current) => {
            const currentCompletion = (current.completedActivities / current.totalActivities) * 100;
            const favCompletion = (fav.completedActivities / fav.totalActivities) * 100;
            return currentCompletion > favCompletion ? current : fav;
          }).courseName;
        } else {
          // If no completions, pick the course with most activities
          favoriteCourse = courses.reduce((fav, current) => 
            current.totalActivities > fav.totalActivities ? current : fav
          ).courseName;
        }
      }

      // CORRECTED: Calculate active courses (courses with any completion)
      const activeCourses = courses.filter(course => course.completedActivities > 0).length;

      return {
        student: {
          id: student.id,
          fullname: student.fullname,
          email: student.email,
          username: student.username,
          roles: student.roles,
          firstAccess: student.firstaccess,
          lastAccess: student.lastaccess,
          isActive: isActive
        },
        overallStatistics: {
          totalActivities: statistics.totalactivities || 0,
          activitiesCompleted: statistics.activitiescompleted || 0,
          completionPercentage: statistics.completionpercentage || 0,
          passPercentage: statistics.passpercentage || 0,
          performanceLevel: performanceLevel
        },
        enrolledCourses: courses.map(course => ({
          ...course,
          completionPercentage: course.totalActivities > 0 ? 
            ((course.completedActivities / course.totalActivities) * 100).toFixed(2) : 0
        })),
        summary: {
          totalCourses: courses.length,
          activeCourses: activeCourses, // CORRECTED: Use calculated active courses
          favoriteCourse: favoriteCourse // CORRECTED: Use proper favorite course logic
        }
      };
    });

    // Apply filters if provided
    let filteredEnrollments = enrollments;

    if (course) {
      filteredEnrollments = filteredEnrollments.filter(enrollment => 
        enrollment.enrolledCourses.some(c => 
          c.courseName.toLowerCase().includes(course.toLowerCase())
        )
      );
    }

    if (status === 'active') {
      filteredEnrollments = filteredEnrollments.filter(enrollment => enrollment.student.isActive);
    } else if (status === 'inactive') {
      filteredEnrollments = filteredEnrollments.filter(enrollment => !enrollment.student.isActive);
    }

    if (performance) {
      filteredEnrollments = filteredEnrollments.filter(enrollment => 
        enrollment.overallStatistics.performanceLevel.toLowerCase() === performance.toLowerCase()
      );
    }

    // CORRECTED: Ensure summary matches actual data
    const actualStudentCount = filteredEnrollments.length;
    const activeStudentCount = filteredEnrollments.filter(e => e.student.isActive).length;

    // Step 6: Prepare response with CORRECTED SUMMARY
    const response = {
      success: true,
      data: {
        enrollments: filteredEnrollments,
        summary: {
          totalStudents: actualStudentCount, // CORRECTED: Use actual count
          activeStudents: activeStudentCount, // CORRECTED: Use actual count
          totalCourses: [...new Set(filteredEnrollments.flatMap(e => e.enrolledCourses.map(c => c.courseName)))].length,
          averageCompletion: filteredEnrollments.length > 0 ? 
            (filteredEnrollments.reduce((sum, enrollment) => sum + (enrollment.overallStatistics.completionPercentage || 0), 0) / filteredEnrollments.length).toFixed(2) : 0,
          performanceDistribution: {
            excellent: filteredEnrollments.filter(e => e.overallStatistics.performanceLevel === 'Excellent').length,
            good: filteredEnrollments.filter(e => e.overallStatistics.performanceLevel === 'Good').length,
            average: filteredEnrollments.filter(e => e.overallStatistics.performanceLevel === 'Average').length,
            belowAverage: filteredEnrollments.filter(e => e.overallStatistics.performanceLevel === 'Below Average').length,
            poor: filteredEnrollments.filter(e => e.overallStatistics.performanceLevel === 'Poor').length
          }
        }
      }
    };

    console.log(`✅ Retrieved ${filteredEnrollments.length} student enrollments`);
    res.json(response);
    
  } catch (error) {
    console.error('❌ API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 8. Get students summary dashboard
app.get('/api/students/summary', async (req, res) => {
  try {
    console.log('📊 Generating students summary dashboard...');

    // Get all students count
    const { count: totalStudents, error: studentsError } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true });

    if (studentsError) throw studentsError;

    // Get active students (accessed in last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const { count: activeStudents, error: activeError } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true })
      .gt('lastaccess', sevenDaysAgo.toISOString());

    if (activeError) throw activeError;

    // Get student statistics for averages
    const { data: studentStats, error: statsError } = await supabase
      .from('student_statistics')
      .select('completionpercentage, passpercentage, performancelevel');

    if (statsError) throw statsError;

    // Calculate averages
    const avgCompletion = studentStats.length > 0 ? 
      (studentStats.reduce((sum, stat) => sum + (stat.completionpercentage || 0), 0) / studentStats.length).toFixed(2) : 0;
    
    const avgPassRate = studentStats.length > 0 ? 
      (studentStats.reduce((sum, stat) => sum + (stat.passpercentage || 0), 0) / studentStats.length).toFixed(2) : 0;

    // Performance distribution
    const performanceDistribution = {
      excellent: studentStats.filter(s => s.performancelevel === 'Excellent').length,
      good: studentStats.filter(s => s.performancelevel === 'Good').length,
      average: studentStats.filter(s => s.performancelevel === 'Average').length,
      belowAverage: studentStats.filter(s => s.performancelevel === 'Below Average').length,
      poor: studentStats.filter(s => s.performancelevel === 'Poor').length
    };

    // Get recent activity
    const { data: recentCompletions, error: recentError } = await supabase
      .from('completions')
      .select('completiondate')
      .not('completiondate', 'is', null)
      .order('completiondate', { ascending: false })
      .limit(1)
      .single();

    if (recentError && recentError.code !== 'PGRST116') throw recentError;

    const response = {
      success: true,
      data: {
        overview: {
          totalStudents: totalStudents || 0,
          activeStudents: activeStudents || 0,
          inactiveStudents: (totalStudents || 0) - (activeStudents || 0),
          activityRate: totalStudents > 0 ? ((activeStudents / totalStudents) * 100).toFixed(2) : 0
        },
        performance: {
          averageCompletion: avgCompletion,
          averagePassRate: avgPassRate,
          distribution: performanceDistribution
        },
        recentActivity: {
          lastCompletion: recentCompletions?.completiondate || null,
          lastUpdate: new Date().toISOString()
        },
        courses: {
          // This would need a courses table to be accurate
          totalEnrolled: 'N/A',
          averageCoursesPerStudent: 'N/A'
        }
      }
    };

    console.log('✅ Students summary dashboard generated');
    res.json(response);
    
  } catch (error) {
    console.error('❌ API Error:', error);
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