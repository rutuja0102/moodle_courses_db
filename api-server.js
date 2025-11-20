require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const MoodleActivityTracker = require('./moodle-tracker');
const cors = require('cors');

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
    'http://localhost:5174'
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
    const { visible, search } = req.query;

    // Use the view for efficient querying
    let query = supabase
      .from('course_enrollment_summary')
      .select('*');

    if (visible !== undefined) {
      query = query.eq('visible', visible === 'true');
    }

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,short_name.ilike.%${search}%`);
    }

    const { data, error } = await query.order('full_name');

    if (error) throw error;

    res.json({
      success: true,
      courses: data
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