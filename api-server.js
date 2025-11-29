require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// MIDDLEWARE & SUPABASE SETUP (KEEP EXISTING)
// ============================================================================

// ✅ CORS Configuration
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001', 
    'http://localhost:5173',
    'http://localhost:5174',
    'https://moodle-fe.onrender.com'
  ].filter(Boolean),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json());

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// Add logging middleware from server.js
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// ENDPOINT 1: GET ALL COURSES WITH ENROLLMENT COUNT
// Per Course: How Many Students Are Enrolled
// ============================================================================

app.get('/api/courses', async (req, res) => {
  try {
    const { visible, search, month, year, dateField = 'created_at' } = req.query;

    // Use your existing view for basic data
    let query = supabase
      .from('course_enrollment_summary')
      .select('*');

    if (visible !== undefined) {
      query = query.eq('visible', visible === 'true');
    }

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,short_name.ilike.%${search}%`);
    }

    const { data: summaryData, error } = await query.order('full_name');
    if (error) throw error;

    // If monthly filter is applied, we need to filter by date from the courses table
    let filteredData = summaryData;
    
    if (month && year) {
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      
      // Validate month and year
      if (monthNum < 1 || monthNum > 12) {
        return res.status(400).json({
          success: false,
          error: 'Month must be between 1 and 12'
        });
      }

      if (yearNum < 2000 || yearNum > 2100) {
        return res.status(400).json({
          success: false,
          error: 'Year must be between 2000 and 2100'
        });
      }

      // Get course IDs that match the date filter
      const startDate = new Date(yearNum, monthNum - 1, 1);
      const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);

      const validDateFields = ['created_at', 'updated_at', 'start_date', 'end_date'];
      const actualDateField = validDateFields.includes(dateField) ? dateField : 'created_at';

      const { data: filteredCourses } = await supabase
        .from('courses')
        .select('course_id')
        .gte(actualDateField, startDate.toISOString())
        .lte(actualDateField, endDate.toISOString());

      const filteredCourseIds = filteredCourses?.map(c => c.course_id) || [];
      
      // Filter the summary data by course IDs that match the date criteria
      filteredData = summaryData.filter(course => 
        filteredCourseIds.includes(course.course_id)
      );
    } else if (month || year) {
      return res.status(400).json({
        success: false,
        error: 'Both month and year parameters are required for monthly filtering'
      });
    }

    res.json({
      success: true,
      courses: filteredData,
      filters: {
        month: month || null,
        year: year || null,
        dateField: dateField,
        total: filteredData.length
      }
    });

  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 2: GET COURSE DETAILS WITH COMPLETION STATS
// ============================================================================

app.get('/api/courses/:courseId', async (req, res) => {
  try {
    const { courseId } = req.params;

    // Get course basic info
    const { data: courseData, error: courseError } = await supabase
      .from('courses')
      .select('*')
      .eq('course_id', parseInt(courseId))
      .single();

    if (courseError) throw courseError;

    if (!courseData) {
      return res.status(404).json({ 
        success: false, 
        error: 'Course not found' 
      });
    }

    // Get enrollment count
    const { count: enrollmentCount, error: enrollError } = await supabase
      .from('enrollments')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', parseInt(courseId))
      .eq('status', 'active');

    if (enrollError) throw enrollError;

    // Get activities count
    const { count: activitiesCount, error: activitiesError } = await supabase
      .from('activities')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', parseInt(courseId));

    if (activitiesError) throw activitiesError;

    // Get trackable activities count
    const { count: trackableCount, error: trackableError } = await supabase
      .from('activities')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', parseInt(courseId))
      .eq('has_completion', true);

    if (trackableError) throw trackableError;

    // Get completion statistics
    const { data: completionStats, error: statsError } = await supabase
      .from('course_completions')
      .select('completion_percentage, is_course_completed')
      .eq('course_id', parseInt(courseId));

    if (statsError) throw statsError;

    const avgCompletion = completionStats.length > 0
      ? completionStats.reduce((sum, s) => sum + parseFloat(s.completion_percentage), 0) / completionStats.length
      : 0;

    const completedStudents = completionStats.filter(s => s.is_course_completed).length;

    res.json({
      success: true,
      course: {
        ...courseData,
        enrolled_students: enrollmentCount,
        total_activities: activitiesCount,
        trackable_activities: trackableCount,
        avg_completion_percentage: avgCompletion.toFixed(2),
        students_completed: completedStudents
      }
    });

  } catch (error) {
    console.error('Error fetching course details:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 3: GET STUDENTS ENROLLED IN A COURSE
// With Completion Status
// ============================================================================

app.get('/api/courses/:courseId/students', async (req, res) => {
  try {
    const { courseId } = req.params;
    const { status, search, page = 1, limit = 50 } = req.query;

    let query = supabase
      .from('student_course_progress')
      .select('*', { count: 'exact' })
      .eq('course_id', parseInt(courseId));

    if (status) {
      if (status === 'completed') {
        query = query.eq('is_course_completed', true);
      } else if (status === 'incomplete') {
        query = query.eq('is_course_completed', false);
      }
    }

    if (search) {
      query = query.or(`student_name.ilike.%${search}%,student_email.ilike.%${search}%`);
    }

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query.order('student_name');

    if (error) throw error;

    res.json({
      success: true,
      students: data,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 4: GET ACTIVITIES/CLASSES IN A COURSE
// Per Course: Which Classes Are Completed
// ============================================================================

app.get('/api/courses/:courseId/activities', async (req, res) => {
  try {
    const { courseId } = req.params;
    const { sectionNumber, activityType, hasCompletion } = req.query;

    let query = supabase
      .from('activity_completion_by_course')
      .select('*')
      .eq('course_id', parseInt(courseId));

    if (sectionNumber) {
      query = query.eq('section_number', parseInt(sectionNumber));
    }

    if (activityType && activityType !== 'all') {
      query = query.eq('activity_type', activityType);
    }

    const { data, error } = await query.order('section_number').order('activity_name');

    if (error) throw error;

    // Group by sections
    const sections = {};
    data.forEach(activity => {
      const sectionKey = activity.section_number;
      if (!sections[sectionKey]) {
        sections[sectionKey] = {
          section_number: activity.section_number,
          section_name: activity.section_name,
          activities: []
        };
      }
      sections[sectionKey].activities.push(activity);
    });

    res.json({
      success: true,
      activities: data,
      sections: Object.values(sections)
    });

  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 5: GET STUDENT PROGRESS IN A COURSE
// Individual Student: Which Classes Completed
// ============================================================================

app.get('/api/courses/:courseId/students/:studentId/progress', async (req, res) => {
  try {
    const { courseId, studentId } = req.params;

    // Get student enrollment info
    const { data: enrollment, error: enrollError } = await supabase
      .from('enrollments')
      .select('*')
      .eq('course_id', parseInt(courseId))
      .eq('student_id', parseInt(studentId))
      .single();

    if (enrollError) throw enrollError;

    if (!enrollment) {
      return res.status(404).json({ 
        success: false, 
        error: 'Student not enrolled in this course' 
      });
    }

    // Get all activities in the course
    const { data: activities, error: activitiesError } = await supabase
      .from('activities')
      .select('*')
      .eq('course_id', parseInt(courseId))
      .eq('has_completion', true);

    if (activitiesError) throw activitiesError;

    // Get student's completions
    const { data: completions, error: completionsError } = await supabase
      .from('activity_completions')
      .select('*')
      .eq('course_id', parseInt(courseId))
      .eq('student_id', parseInt(studentId));

    if (completionsError) throw completionsError;

    // Create completion map
    const completionMap = {};
    completions.forEach(c => {
      completionMap[c.activity_id] = c;
    });

    // Combine activities with completion status
    const activitiesWithCompletion = activities.map(activity => ({
      ...activity,
      completion: completionMap[activity.activity_id] || {
        is_completed: false,
        is_passed: false,
        is_failed: false,
        time_completed: null
      }
    }));

    // Group by sections
    const sections = {};
    activitiesWithCompletion.forEach(activity => {
      const sectionKey = activity.section_number;
      if (!sections[sectionKey]) {
        sections[sectionKey] = {
          section_number: activity.section_number,
          section_name: activity.section_name,
          activities: [],
          total: 0,
          completed: 0
        };
      }
      sections[sectionKey].activities.push(activity);
      sections[sectionKey].total++;
      if (activity.completion.is_completed) {
        sections[sectionKey].completed++;
      }
    });

    // Calculate summary
    const totalActivities = activities.length;
    const completedActivities = completions.filter(c => c.is_completed).length;
    const passedActivities = completions.filter(c => c.is_passed).length;
    const failedActivities = completions.filter(c => c.is_failed).length;

    res.json({
      success: true,
      student: enrollment,
      summary: {
        total_activities: totalActivities,
        completed_activities: completedActivities,
        passed_activities: passedActivities,
        failed_activities: failedActivities,
        completion_percentage: totalActivities > 0 
          ? ((completedActivities / totalActivities) * 100).toFixed(2)
          : 0
      },
      sections: Object.values(sections).sort((a, b) => a.section_number - b.section_number),
      activities: activitiesWithCompletion
    });

  } catch (error) {
    console.error('Error fetching student progress:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 6: GET COMPLETION STATISTICS FOR A COURSE
// ============================================================================

app.get('/api/courses/:courseId/stats', async (req, res) => {
  try {
    const { courseId } = req.params;

    // Get overall stats from view
    const { data: stats, error: statsError } = await supabase
      .from('course_completion_stats')
      .select('*')
      .eq('course_id', parseInt(courseId))
      .single();

    if (statsError) throw statsError;

    // Get completion by activity type
    const { data: activities, error: activitiesError } = await supabase
      .from('activity_completion_by_course')
      .select('*')
      .eq('course_id', parseInt(courseId));

    if (activitiesError) throw activitiesError;

    // Group by activity type
    const byType = {};
    activities.forEach(activity => {
      if (!byType[activity.activity_type]) {
        byType[activity.activity_type] = {
          total: 0,
          avg_completion_rate: 0,
          activities: []
        };
      }
      byType[activity.activity_type].total++;
      byType[activity.activity_type].activities.push(activity);
    });

    // Calculate average completion rate per type
    Object.keys(byType).forEach(type => {
      const avgRate = byType[type].activities.reduce(
        (sum, a) => sum + parseFloat(a.completion_rate || 0), 0
      ) / byType[type].total;
      byType[type].avg_completion_rate = avgRate.toFixed(2);
    });

    // Get completion by section
    const bySection = {};
    activities.forEach(activity => {
      const key = activity.section_number;
      if (!bySection[key]) {
        bySection[key] = {
          section_number: activity.section_number,
          section_name: activity.section_name,
          total_activities: 0,
          avg_completion_rate: 0,
          activities: []
        };
      }
      bySection[key].total_activities++;
      bySection[key].activities.push(activity);
    });

    // Calculate average completion rate per section
    Object.keys(bySection).forEach(key => {
      const avgRate = bySection[key].activities.reduce(
        (sum, a) => sum + parseFloat(a.completion_rate || 0), 0
      ) / bySection[key].total_activities;
      bySection[key].avg_completion_rate = avgRate.toFixed(2);
    });

    res.json({
      success: true,
      stats: {
        ...stats,
        by_activity_type: byType,
        by_section: Object.values(bySection).sort((a, b) => a.section_number - b.section_number)
      }
    });

  } catch (error) {
    console.error('Error fetching course stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 7: FILTER STUDENTS BY COMPLETION CRITERIA
// ============================================================================

app.get('/api/students/filter', async (req, res) => {
  try {
    const {
      courseId,
      minCompletion,
      maxCompletion,
      isCompleted,
      search,
      page = 1,
      limit = 50
    } = req.query;

    let query = supabase
      .from('student_course_progress')
      .select('*', { count: 'exact' });

    if (courseId) {
      query = query.eq('course_id', parseInt(courseId));
    }

    if (minCompletion) {
      query = query.gte('completion_percentage', parseFloat(minCompletion));
    }

    if (maxCompletion) {
      query = query.lte('completion_percentage', parseFloat(maxCompletion));
    }

    if (isCompleted !== undefined) {
      query = query.eq('is_course_completed', isCompleted === 'true');
    }

    if (search) {
      query = query.or(`student_name.ilike.%${search}%,student_email.ilike.%${search}%`);
    }

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query.order('completion_percentage', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      students: data,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Error filtering students:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 8: GET FILTER OPTIONS
// ============================================================================

// Get all courses for dropdown
app.get('/api/filters/courses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('course_id, short_name, full_name')
      .eq('visible', true)
      .order('full_name');

    if (error) throw error;

    res.json({ success: true, courses: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get activity types for a course
app.get('/api/filters/activity-types', async (req, res) => {
  try {
    const { courseId } = req.query;

    let query = supabase
      .from('activities')
      .select('activity_type');

    if (courseId) {
      query = query.eq('course_id', parseInt(courseId));
    }

    const { data, error } = await query;

    if (error) throw error;

    const uniqueTypes = [...new Set(data.map(item => item.activity_type))].sort();

    res.json({ success: true, activityTypes: uniqueTypes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get sections for a course
app.get('/api/filters/sections', async (req, res) => {
  try {
    const { courseId } = req.query;

    if (!courseId) {
      return res.status(400).json({ 
        success: false, 
        error: 'courseId is required' 
      });
    }

    const { data, error } = await supabase
      .from('activities')
      .select('section_number, section_name')
      .eq('course_id', parseInt(courseId));

    if (error) throw error;

    const uniqueSections = [...new Map(
      data.map(item => [item.section_number, {
        number: item.section_number,
        name: item.section_name
      }])
    ).values()].sort((a, b) => a.number - b.number);

    res.json({ success: true, sections: uniqueSections });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 9: EXPORT DATA
// ============================================================================

app.get('/api/export/course/:courseId', async (req, res) => {
  try {
    const { courseId } = req.params;
    const { format = 'students' } = req.query;

    let data, headers;

    if (format === 'students') {
      // Export student progress
      const { data: students, error } = await supabase
        .from('student_course_progress')
        .select('*')
        .eq('course_id', parseInt(courseId));

      if (error) throw error;
      data = students;
      headers = ['student_id', 'student_name', 'student_email', 'total_activities', 
                 'completed_activities', 'completion_percentage', 'is_course_completed'];
    } else if (format === 'activities') {
      // Export activities
      const { data: activities, error } = await supabase
        .from('activity_completion_by_course')
        .select('*')
        .eq('course_id', parseInt(courseId));

      if (error) throw error;
      data = activities;
      headers = ['activity_id', 'activity_name', 'activity_type', 'section_name', 
                 'total_students', 'students_completed', 'completion_rate'];
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, error: 'No data to export' });
    }

    // Create CSV
    const csvHeaders = headers.join(',');
    const csvRows = data.map(row =>
      headers.map(header => {
        const val = row[header];
        return typeof val === 'string' && val.includes(',') ? `"${val}"` : val;
      }).join(',')
    );

    const csv = [csvHeaders, ...csvRows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=course_${courseId}_${format}.csv`);
    res.send(csv);

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

class MoodleAPIClient {
  constructor(url, token) {
    this.baseUrl = url;
    this.token = token;
  }

  /**
   * Call any Moodle Web Service function
   */
  async callFunction(functionName, params = {}) {
    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          wstoken: this.token,
          wsfunction: functionName,
          moodlewsrestformat: 'json',
          ...params
        },
        timeout: 30000
      });

      if (response.data.exception) {
        throw new Error(response.data.message || 'Moodle API Error');
      }

      return response.data;
    } catch (error) {
      console.error(`Error calling ${functionName}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all courses
   */
  async getCourses() {
    return await this.callFunction('core_course_get_courses');
  }

  /**
   * Get enrolled users in a course
   */
  async getEnrolledUsers(courseId) {
    return await this.callFunction('core_enrol_get_enrolled_users', {
      courseid: courseId
    });
  }

  /**
   * Get course contents (sections and activities)
   */
  async getCourseContents(courseId) {
    return await this.callFunction('core_course_get_contents', {
      courseid: courseId
    });
  }

  /**
   * Get course completion status for a user
   */
  async getCourseCompletionStatus(courseId, userId) {
    return await this.callFunction('core_completion_get_course_completion_status', {
      courseid: courseId,
      userid: userId
    });
  }

  /**
   * Get activities completion status for a user
   */
  async getActivitiesCompletionStatus(courseId, userId) {
    return await this.callFunction('core_completion_get_activities_completion_status', {
      courseid: courseId,
      userid: userId
    });
  }
}

// ============================================================================
// ENDPOINT: SYNC SINGLE COURSE FROM MOODLE TO SUPABASE
// ============================================================================

app.post('/api/moodle/sync/course/:courseId', async (req, res) => {
  const startTime = Date.now();
  const { courseId } = req.params;
  
  console.log('\n' + '='.repeat(80));
  console.log(`🔄 STARTING MOODLE SYNC FOR COURSE ${courseId}`);
  console.log('='.repeat(80));

  try {
    // Initialize Moodle client
    const moodle = new MoodleAPIClient(
      process.env.MOODLE_URL || 'http://omkaravidya.online/webservice/rest/server.php',
      process.env.MOODLE_TOKEN || '38fff46a850ec4d191e01a2916bad4b3'
    );

    const syncResults = {
      course: { success: 0, failed: 0 },
      enrollments: { success: 0, failed: 0 },
      activities: { success: 0, failed: 0 },
      completions: { success: 0, failed: 0 },
      courseCompletions: { success: 0, failed: 0 },
      errors: []
    };

    // ========================================================================
    // STEP 1: Fetch and Save Course Information
    // ========================================================================
    console.log('\n📚 Step 1/5: Fetching course information...');
    
    const courses = await moodle.getCourses();
    const course = courses.find(c => c.id === parseInt(courseId));
    
    if (!course) {
      return res.status(404).json({
        success: false,
        error: `Course ${courseId} not found`
      });
    }

    console.log(`   ✓ Found: ${course.fullname}`);

    // Save course to Supabase - FIXED COLUMN NAMES
    const courseData = {
      course_id: course.id,
      short_name: course.shortname,
      full_name: course.fullname,
      category_id: course.categoryid || 0,
      category_name: null, // You may need to fetch this separately
      summary: course.summary || '',
      format: course.format || 'topics',
      start_date: course.startdate ? new Date(course.startdate * 1000) : null,
      end_date: course.enddate ? new Date(course.enddate * 1000) : null,
      visible: course.visible === 1,
      updated_at: new Date()
    };

    const { error: courseError } = await supabase
      .from('courses')
      .upsert([courseData], { onConflict: 'course_id' });

    if (courseError) {
      console.error('   ✗ Error saving course:', courseError.message);
      syncResults.course.failed = 1;
      syncResults.errors.push(`Course: ${courseError.message}`);
    } else {
      console.log('   ✓ Course saved to Supabase');
      syncResults.course.success = 1;
    }

    // ========================================================================
    // STEP 2: Fetch and Save Enrolled Students
    // ========================================================================
    console.log('\n👥 Step 2/5: Fetching enrolled students...');
    
    const enrolledUsers = await moodle.getEnrolledUsers(courseId);
    console.log(`   ✓ Found ${enrolledUsers.length} enrolled users`);

    // Filter only students (exclude teachers, admins, etc.)
    const students = enrolledUsers.filter(user => 
      user.roles && user.roles.some(role => 
        role.shortname === 'student' || role.roleid === 5
      )
    );

    console.log(`   ✓ Filtered to ${students.length} students`);

    // Save enrollments to Supabase - FIXED COLUMN NAMES
    if (students.length > 0) {
      const enrollmentsData = students.map(student => ({
        course_id: parseInt(courseId),
        student_id: student.id,
        student_name: `${student.firstname} ${student.lastname}`,
        student_email: student.email || '',
        student_first_name: student.firstname,
        student_last_name: student.lastname,
        enrollment_date: student.firstaccess ? new Date(student.firstaccess * 1000) : new Date(),
        role: 'student',
        status: 'active',
        updated_at: new Date()
      }));

      const { error: enrollError } = await supabase
        .from('enrollments')
        .upsert(enrollmentsData, { onConflict: 'course_id,student_id' });

      if (enrollError) {
        console.error('   ✗ Error saving enrollments:', enrollError.message);
        syncResults.enrollments.failed = students.length;
        syncResults.errors.push(`Enrollments: ${enrollError.message}`);
      } else {
        console.log(`   ✓ Saved ${students.length} enrollments to Supabase`);
        syncResults.enrollments.success = students.length;
      }
    }

    // ========================================================================
    // STEP 3: Fetch and Save Course Activities
    // ========================================================================
    console.log('\n📖 Step 3/5: Fetching course content and activities...');
    
    const courseContents = await moodle.getCourseContents(courseId);
    console.log(`   ✓ Found ${courseContents.length} sections`);

    const allActivities = [];
    courseContents.forEach(section => {
      if (section.modules && section.modules.length > 0) {
        section.modules.forEach(module => {
          allActivities.push({
            course_id: parseInt(courseId),
            activity_id: module.id,
            section_id: section.id,
            section_number: section.section,
            section_name: section.name,
            activity_name: module.name,
            activity_type: module.modname,
            activity_url: module.url || null, // FIXED: activity_url instead of url
            description: module.description || '',
            visible: module.visible === 1,
            availability_start: null,
            availability_end: null,
            has_completion: (module.completion || 0) > 0,
            completion_expected: module.completionexpected ? new Date(module.completionexpected * 1000) : null,
            updated_at: new Date()
          });
        });
      }
    });

    console.log(`   ✓ Found ${allActivities.length} activities`);

    if (allActivities.length > 0) {
      const { error: activitiesError } = await supabase
        .from('activities')
        .upsert(allActivities, { onConflict: 'course_id,activity_id' });

      if (activitiesError) {
        console.error('   ✗ Error saving activities:', activitiesError.message);
        syncResults.activities.failed = allActivities.length;
        syncResults.errors.push(`Activities: ${activitiesError.message}`);
      } else {
        console.log(`   ✓ Saved ${allActivities.length} activities to Supabase`);
        syncResults.activities.success = allActivities.length;
      }
    }

    // ========================================================================
    // STEP 4: Fetch and Save Activity Completions
    // ========================================================================
    console.log('\n✅ Step 4/5: Fetching completion data for all students...');
    
    const allCompletions = [];
    let processedStudents = 0;
    let studentsWithCompletions = 0;

    for (const student of students) {
      processedStudents++;
      process.stdout.write(`   Processing ${processedStudents}/${students.length}: ${student.firstname} ${student.lastname}\r`);

      try {
        // Get activities completion status
        const activitiesCompletion = await moodle.getActivitiesCompletionStatus(courseId, student.id);

        // Process each activity completion
        if (activitiesCompletion.statuses && activitiesCompletion.statuses.length > 0) {
          studentsWithCompletions++;
          
          activitiesCompletion.statuses.forEach(status => {
            // Find the activity name from our activities list
            const activity = allActivities.find(a => a.activity_id === status.cmid);
            
            allCompletions.push({
              course_id: parseInt(courseId),
              student_id: student.id,
              activity_id: status.cmid,
              activity_name: activity ? activity.activity_name : '',
              activity_type: activity ? activity.activity_type : '',
              completion_state: status.state || 0,
              is_completed: status.state >= 1,
              is_passed: status.state === 2,
              is_failed: status.state === 3,
              time_completed: status.timecompleted ? new Date(status.timecompleted * 1000) : null,
              tracking_type: status.tracking || 0,
              updated_at: new Date()
            });
          });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        // Skip "No completion criteria" errors as they're expected for some courses
        if (!error.message.includes('No completion criteria')) {
          console.log(`\n   ⚠️  Error fetching completions for student ${student.id}: ${error.message}`);
        }
      }
    }

    console.log(`\n   ✓ Fetched ${allCompletions.length} completion records from ${studentsWithCompletions}/${students.length} students`);

    // Save completions in batches
    if (allCompletions.length > 0) {
      console.log('   💾 Saving completions to Supabase...');
      
      const batchSize = 100;
      let savedCount = 0;

      for (let i = 0; i < allCompletions.length; i += batchSize) {
        const batch = allCompletions.slice(i, i + batchSize);
        
        const { error: completionsError } = await supabase
          .from('activity_completions')
          .upsert(batch, { onConflict: 'course_id,student_id,activity_id' });

        if (completionsError) {
          console.error(`\n   ✗ Error saving completions batch: ${completionsError.message}`);
          syncResults.completions.failed += batch.length;
          syncResults.errors.push(`Completions: ${completionsError.message}`);
        } else {
          savedCount += batch.length;
          syncResults.completions.success += batch.length;
          process.stdout.write(`   Saved ${savedCount}/${allCompletions.length} completions\r`);
        }
      }
      console.log(`\n   ✓ Saved all completions to Supabase`);
    } else {
      console.log('   ℹ️  No completion data available (completion tracking may not be enabled for this course)');
    }

    // ========================================================================
    // STEP 5: Calculate and Save Course Completions Summary
    // ========================================================================
    console.log('\n📊 Step 5/5: Calculating course completion statistics...');

    const trackableActivities = allActivities.filter(a => a.has_completion);
    console.log(`   ℹ️  Found ${trackableActivities.length} trackable activities`);
    
    if (trackableActivities.length > 0) {
      const courseCompletionsData = [];
      
      for (const student of students) {
        const studentCompletions = allCompletions.filter(
          c => c.student_id === student.id && c.is_completed
        );

        const completedCount = studentCompletions.length;
        const totalCount = trackableActivities.length;
        const completionPercentage = totalCount > 0
          ? (completedCount / totalCount) * 100
          : 0;

        const isCourseCompleted = completionPercentage >= 100;

        courseCompletionsData.push({
          course_id: parseInt(courseId),
          student_id: student.id,
          total_activities: totalCount,
          completed_activities: completedCount,
          completion_percentage: parseFloat(completionPercentage.toFixed(2)),
          is_course_completed: isCourseCompleted,
          completion_date: isCourseCompleted && studentCompletions.length > 0 
            ? studentCompletions[studentCompletions.length - 1].time_completed 
            : null,
          updated_at: new Date()
        });
      }

      const { error: ccError } = await supabase
        .from('course_completions')
        .upsert(courseCompletionsData, { onConflict: 'course_id,student_id' });

      if (ccError) {
        console.error('   ✗ Error saving course completions:', ccError.message);
        syncResults.courseCompletions.failed = students.length;
        syncResults.errors.push(`CourseCompletions: ${ccError.message}`);
      } else {
        console.log(`   ✓ Saved course completion stats for ${students.length} students`);
        syncResults.courseCompletions.success = students.length;
      }
    } else {
      console.log('   ℹ️  Skipping course completions (no trackable activities)');
    }

    // ========================================================================
    // FINAL RESULTS
    // ========================================================================
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n' + '='.repeat(80));
    console.log('✅ SYNC COMPLETED SUCCESSFULLY!');
    console.log('='.repeat(80));
    console.log(`⏱️  Processing Time: ${processingTime}s`);
    console.log(`📚 Course: ${syncResults.course.success} saved`);
    console.log(`📝 Enrollments: ${syncResults.enrollments.success} saved`);
    console.log(`📖 Activities: ${syncResults.activities.success} saved`);
    console.log(`✅ Completions: ${syncResults.completions.success} saved`);
    console.log(`📊 Course Stats: ${syncResults.courseCompletions.success} saved`);
    
    if (syncResults.errors.length > 0) {
      console.log(`\n⚠️  Errors encountered:`);
      syncResults.errors.forEach(err => console.log(`   - ${err}`));
    }
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      message: `Course ${courseId} synced successfully`,
      courseInfo: {
        id: course.id,
        name: course.fullname,
        shortname: course.shortname
      },
      results: syncResults,
      processingTime: `${processingTime}s`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('\n❌ SYNC FAILED:', error.message);
    console.error(error.stack);
    
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ============================================================================
// ENDPOINT: SYNC ALL VISIBLE COURSES FROM MOODLE
// ============================================================================

app.post('/api/moodle/sync/all-courses', async (req, res) => {
  console.log('\n🔄 Starting sync for ALL courses...');

  try {
    const moodle = new MoodleAPIClient(
      process.env.MOODLE_URL || 'http://omkaravidya.online/webservice/rest/server.php',
      process.env.MOODLE_TOKEN || '38fff46a850ec4d191e01a2916bad4b3'
    );

    const courses = await moodle.getCourses();
    const visibleCourses = courses.filter(c => c.visible === 1 && c.id > 1); // Skip site course (ID 1)
    
    console.log(`Found ${visibleCourses.length} visible courses to sync`);

    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < visibleCourses.length; i++) {
      const course = visibleCourses[i];
      console.log(`\n[${i + 1}/${visibleCourses.length}] 📚 Syncing: ${course.fullname} (ID: ${course.id})`);
      
      try {
        // Call the single course sync internally
        const response = await axios.post(
          `http://localhost:${PORT || 3000}/api/moodle/sync/course/${course.id}`
        );
        
        results.push({
          courseId: course.id,
          courseName: course.fullname,
          success: true,
          data: response.data
        });
        successCount++;
      } catch (error) {
        console.error(`   ✗ Failed to sync course ${course.id}: ${error.message}`);
        results.push({
          courseId: course.id,
          courseName: course.fullname,
          success: false,
          error: error.message
        });
        failCount++;
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ ALL COURSES SYNC COMPLETED');
    console.log('='.repeat(80));
    console.log(`✅ Success: ${successCount}/${visibleCourses.length}`);
    console.log(`❌ Failed: ${failCount}/${visibleCourses.length}`);
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      message: `Synced ${successCount}/${visibleCourses.length} courses`,
      summary: {
        total: visibleCourses.length,
        success: successCount,
        failed: failCount
      },
      results: results
    });

  } catch (error) {
    console.error('❌ Error syncing all courses:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// ENDPOINT: TEST MOODLE CONNECTION
// ============================================================================

app.get('/api/moodle/test-connection', async (req, res) => {
  try {
    const moodle = new MoodleAPIClient(
      process.env.MOODLE_URL || 'http://omkaravidya.online/webservice/rest/server.php',
      process.env.MOODLE_TOKEN || '38fff46a850ec4d191e01a2916bad4b3'
    );

    console.log('🔍 Testing Moodle connection...');
    const courses = await moodle.getCourses();
    console.log(`✅ Connection successful! Found ${courses.length} courses`);

    res.json({
      success: true,
      message: 'Moodle connection successful',
      moodleUrl: process.env.MOODLE_URL || 'http://omkaravidya.online/webservice/rest/server.php',
      coursesFound: courses.length,
      sampleCourses: courses.slice(0, 5).map(c => ({
        id: c.id,
        name: c.fullname,
        visible: c.visible === 1
      }))
    });

  } catch (error) {
    console.error('❌ Connection test failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to connect to Moodle. Please check your MOODLE_URL and MOODLE_TOKEN.'
    });
  }
});

// ============================================================================
// ENDPOINT: GET SYNC STATUS
// ============================================================================

app.get('/api/moodle/sync/status/:courseId', async (req, res) => {
  try {
    const { courseId } = req.params;

    // Get course info
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('*')
      .eq('course_id', parseInt(courseId))
      .single();

    if (courseError) throw courseError;

    // Get counts
    const { count: enrollmentCount } = await supabase
      .from('enrollments')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', parseInt(courseId));

    const { count: activityCount } = await supabase
      .from('activities')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', parseInt(courseId));

    const { count: completionCount } = await supabase
      .from('activity_completions')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', parseInt(courseId));

    res.json({
      success: true,
      course: course,
      stats: {
        enrollments: enrollmentCount || 0,
        activities: activityCount || 0,
        completions: completionCount || 0,
        lastUpdated: course.updated_at
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log('='.repeat(80));
  console.log('🚀 MOODLE COURSE ENROLLMENT & COMPLETION API');
  console.log('='.repeat(80));
  console.log(`✅ Server: http://localhost:${PORT}`);
  console.log(`✅ Supabase: ${process.env.SUPABASE_URL}`);
  console.log('\n📊 KEY FEATURES:');
  console.log('  ✓ Per course: How many students enrolled');
  console.log('  ✓ Per course: Which classes/activities completed');
  console.log('  ✓ Student progress tracking');
  console.log('  ✓ Completion statistics');
  console.log('\n📊 API ENDPOINTS:');
  console.log('─'.repeat(80));
  console.log('COURSES:');
  console.log(`  GET  /api/courses                              - All courses with enrollment`);
  console.log(`  GET  /api/courses/:courseId                    - Course details + stats`);
  console.log(`  GET  /api/courses/:courseId/students           - Students in course`);
  console.log(`  GET  /api/courses/:courseId/activities         - Activities/classes in course`);
  console.log(`  GET  /api/courses/:courseId/stats              - Course completion stats`);
  console.log('\nSTUDENTS:');
  console.log(`  GET  /api/courses/:courseId/students/:studentId/progress - Student progress`);
  console.log(`  GET  /api/students/filter                      - Filter students by completion`);
  console.log('\nFILTERS:');
  console.log(`  GET  /api/filters/courses                      - Course list for dropdown`);
  console.log(`  GET  /api/filters/activity-types               - Activity types`);
  console.log(`  GET  /api/filters/sections                     - Sections in course`);
  console.log('\nEXPORT:');
  console.log(`  GET  /api/export/course/:courseId?format=students|activities`);
  console.log('='.repeat(80));
});

module.exports = app;