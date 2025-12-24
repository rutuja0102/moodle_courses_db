require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL;

// ============================================================================
// MIDDLEWARE & SUPABASE SETUP (KEEP EXISTING)
// ============================================================================

// CORS Configuration
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:5173",
      "http://localhost:5174",
      "https://moodle-fe.onrender.com",
    ].filter(Boolean),
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  })
);

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
// HELPER FUNCTION: Get Filter Description
// ============================================================================

function getFilterDescription(month, year, groupId, groupInfo) {
  const parts = [];
  
  if (month && year) {
    parts.push(`for ${month}/${year}`);
  }
  
  if (groupId && groupInfo) {
    parts.push(`in group "${groupInfo.group_name}"`);
  }
  
  if (parts.length === 0) {
    return "Showing all data";
  }
  
  return `Showing data ${parts.join(" ")}`;
}

// ============================================================================
// HELPER FUNCTION: Get Filter Type
// ============================================================================

function getFilterType(hasDateFilter, hasGroupFilter) {
  if (hasDateFilter && hasGroupFilter) return "monthly_group";
  if (hasDateFilter) return "monthly";
  if (hasGroupFilter) return "group";
  return "none";
}

// ============================================================================
// HELPER FUNCTION: Create Date Filter
// ============================================================================

function createMonthFilter(month, year) {
  if (!month || !year) return null;

  const monthNum = parseInt(month);
  const yearNum = parseInt(year);

  if (monthNum < 1 || monthNum > 12) {
    throw new Error("Month must be between 1 and 12");
  }

  if (yearNum < 2000 || yearNum > 2100) {
    throw new Error("Year must be between 2000 and 2100");
  }

  const startDate = new Date(Date.UTC(yearNum, monthNum - 1, 1, 0, 0, 0));
  const endDate = new Date(Date.UTC(yearNum, monthNum, 0, 23, 59, 59, 999));

  return {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    month: monthNum,
    year: yearNum,
  };
}

// ============================================================================
// ENDPOINT1: GET ALL COURSES + MONTHLY COMPLETION REPORT + GROUP FILTER
// ============================================================================
app.get("/api/courses", async (req, res) => {
  try {
    const {
      visible,
      search,
      month,
      year,
      dateField = "created_at",
      groupId, // Filter by group ID
      hasGroups, // Filter courses that have groups
      groupFilterMode = "course" // NEW: 'course' or 'students'
    } = req.query;

    // ========== Base Query (Course Summary) ==========
    let query = supabase.from("course_enrollment_summary").select("*");

    if (visible !== undefined) query = query.eq("visible", visible === "true");
    if (search)
      query = query.or(
        `full_name.ilike.%${search}%,short_name.ilike.%${search}%`
      );

    const { data: summaryData, error } = await query.order("full_name");
    if (error) throw error;

    let filteredData = summaryData;
    let monthlyStats = null;
    let groupFilterInfo = null;

    // ========== GROUP FILTER ==========
    if (groupId) {
      const groupIdNum = parseInt(groupId);
      
      // Get group details
      const { data: groupDetails, error: groupError } = await supabase
        .from("groups")
        .select("*")
        .eq("group_id", groupIdNum)
        .single();

      if (groupError) {
        return res.status(400).json({
          success: false,
          error: `Group ${groupId} not found`
        });
      }

      groupFilterInfo = {
        group_id: groupDetails.group_id,
        group_name: groupDetails.group_name,
        description: groupDetails.description,
        course_id: groupDetails.course_id
      };

      if (groupFilterMode === "course") {
        // Filter 1: Show only the course that contains this group
        filteredData = filteredData.filter(c => 
          c.course_id === groupDetails.course_id
        );
      } else if (groupFilterMode === "students") {
        // Filter 2: Adjust student counts based on group membership
        // Get students in this group
        const { data: groupMembers, error: membersError } = await supabase
          .from("group_members")
          .select("student_id")
          .eq("group_id", groupIdNum)
          .eq("course_id", groupDetails.course_id);

        if (!membersError && groupMembers && groupMembers.length > 0) {
          const groupStudentIds = groupMembers.map(m => m.student_id);
          
          // Get enrollment count for these students
          const { count: groupEnrollmentCount } = await supabase
            .from("enrollments")
            .select("*", { count: "exact", head: true })
            .eq("course_id", groupDetails.course_id)
            .in("student_id", groupStudentIds)
            .eq("status", "active");

          // Get completion stats for these students
          const { data: groupCompletions } = await supabase
            .from("activity_completions")
            .select("student_id, activity_id, is_completed")
            .eq("course_id", groupDetails.course_id)
            .in("student_id", groupStudentIds)
            .eq("is_completed", true);

          // Filter to show only the course with adjusted stats
          filteredData = filteredData
            .filter(c => c.course_id === groupDetails.course_id)
            .map(course => ({
              ...course,
              // Override counts with group-specific data
              total_students: groupEnrollmentCount || 0,
              active_students: groupEnrollmentCount || 0,
              _original_counts: {
                total_students: course.total_students,
                active_students: course.active_students
              },
              _group_filter_applied: true,
              _group_student_count: groupStudentIds.length
            }));
        }
      }
    }

    // ========== HAS GROUPS FILTER ==========
    if (hasGroups === "true" && !groupId) {
      // Get all courses that have at least one group
      const { data: coursesWithGroups, error: groupsError } = await supabase
        .from("groups")
        .select("course_id")
        .group("course_id");

      if (!groupsError && coursesWithGroups) {
        const courseIdsWithGroups = coursesWithGroups.map(g => g.course_id);
        filteredData = filteredData.filter(c => 
          courseIdsWithGroups.includes(c.course_id)
        );
      }
    } else if (hasGroups === "false" && !groupId) {
      // Get all courses that have no groups
      const { data: coursesWithGroups, error: groupsError } = await supabase
        .from("groups")
        .select("course_id")
        .group("course_id");

      if (!groupsError && coursesWithGroups) {
        const courseIdsWithGroups = coursesWithGroups.map(g => g.course_id);
        filteredData = filteredData.filter(c => 
          !courseIdsWithGroups.includes(c.course_id)
        );
      }
    }

    // ========== MONTH + YEAR FILTER ==========
    if (month && year) {
      const m = parseInt(month),
        y = parseInt(year);

      if (m < 1 || m > 12)
        return res
          .status(400)
          .json({ success: false, error: "Month must be 1–12" });
      if (y < 2000 || y > 2100)
        return res
          .status(400)
          .json({ success: false, error: "Year must be 2000–2100" });

      const startDate = new Date(y, m - 1, 1).toISOString();
      const endDate = new Date(y, m, 0, 23, 59, 59, 999).toISOString();

      // Filter courses based on date field
      const validFields = [
        "created_at",
        "updated_at",
        "start_date",
        "end_date",
      ];
      const field = validFields.includes(dateField) ? dateField : "created_at";

      const { data: filteredCourses } = await supabase
        .from("courses")
        .select("course_id")
        .gte(field, startDate)
        .lte(field, endDate);

      const ids = filteredCourses?.map((c) => c.course_id) || [];
      filteredData = filteredData.filter((c) => ids.includes(c.course_id));

      // ========== COMPLETED ACTIVITIES ==========
      const { data: completedRows } = await supabase
        .from("activity_completions")
        .select("student_id, activity_id, is_completed")
        .eq("is_completed", true)
        .gte("time_completed", startDate)
        .lte("time_completed", endDate);

      // Count completions per student
      const studentCompletionCounts = {};
      completedRows.forEach((c) => {
        studentCompletionCounts[c.student_id] =
          (studentCompletionCounts[c.student_id] || 0) + 1;
      });

      // ========== GET STUDENT NAMES SAFELY ==========
      let studentWiseDetails = [];

      for (const studentId of Object.keys(studentCompletionCounts)) {
        const { data: user } = await supabase
          .from("enrollments")
          .select("*")
          .eq("student_id", studentId)
          .limit(1)
          .single();

        // Dynamically detect correct name column
        const student_name =
          user?.student_name ||
          user?.name ||
          user?.full_name ||
          [user?.firstname, user?.lastname].filter(Boolean).join(" ") ||
          "Unknown";

        studentWiseDetails.push({
          student_id: Number(studentId),
          student_name,
          completed_count: studentCompletionCounts[studentId],
        });
      }

      // ========== FINAL SUMMARY ==========
      monthlyStats = {
        completed_activities: completedRows.length,
        unique_students_completed: Object.keys(studentCompletionCounts).length,
        student_wise_completion: studentWiseDetails,
      };
    }

    // ========== GET GROUPS FOR EACH COURSE ==========
    // Get groups for all filtered courses
    const courseIds = filteredData.map(c => c.course_id);
    let courseGroups = {};
    
    if (courseIds.length > 0) {
      const { data: groups, error: groupsError } = await supabase
        .from("groups")
        .select("course_id, group_id, group_name, description")
        .in("course_id", courseIds)
        .order("group_name");

      if (!groupsError && groups) {
        // Organize groups by course_id
        groups.forEach(group => {
          if (!courseGroups[group.course_id]) {
            courseGroups[group.course_id] = [];
          }
          courseGroups[group.course_id].push({
            group_id: group.group_id,
            group_name: group.group_name,
            description: group.description
          });
        });
      }
    }

    // Add groups to each course
    const coursesWithGroups = filteredData.map(course => ({
      ...course,
      groups: courseGroups[course.course_id] || [],
      has_groups: (courseGroups[course.course_id] || []).length > 0,
      // Add group-specific info if filtered by group
      ...(groupId && course.course_id === groupFilterInfo?.course_id && {
        selected_group: groupFilterInfo
      })
    }));

    // ========== RESPONSE ==========
    return res.json({
      success: true,
      courses: coursesWithGroups,
      monthly: monthlyStats,
      group_filter: groupFilterInfo ? {
        ...groupFilterInfo,
        mode: groupFilterMode
      } : null,
      filters: {
        month: month || null,
        year: year || null,
        groupId: groupId || null,
        hasGroups: hasGroups || null,
        groupFilterMode: groupFilterMode,
        total_courses: filteredData.length,
      },
    });
  } catch (error) {
    console.error("Error fetching courses:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 2: GET COURSE DETAILS WITH COMPLETION STATS (UPDATED WITH GROUP FILTER)
// ============================================================================

app.get("/api/courses/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;
    const { month, year, groupId } = req.query;

    // Get course basic info
    const { data: courseData, error: courseError } = await supabase
      .from("courses")
      .select("*")
      .eq("course_id", parseInt(courseId))
      .single();

    if (courseError) throw courseError;

    if (!courseData) {
      return res.status(404).json({
        success: false,
        error: "Course not found",
      });
    }

    // Get student IDs for group filter if groupId is provided
    let groupStudentIds = null;
    let groupInfo = null;
    
    if (groupId) {
      // Get group information
      const { data: groupData, error: groupError } = await supabase
        .from("groups")
        .select("*")
        .eq("course_id", parseInt(courseId))
        .eq("group_id", parseInt(groupId))
        .single();

      if (groupError) throw groupError;
      
      if (!groupData) {
        return res.status(404).json({
          success: false,
          error: "Group not found in this course",
        });
      }

      groupInfo = {
        group_id: groupData.group_id,
        group_name: groupData.group_name,
        description: groupData.description
      };

      // Get student IDs in this group
      const { data: groupMembers, error: membersError } = await supabase
        .from("group_members")
        .select("student_id")
        .eq("course_id", parseInt(courseId))
        .eq("group_id", parseInt(groupId));

      if (membersError) throw membersError;

      groupStudentIds = groupMembers?.map(m => m.student_id) || [];
    }

    // Create date filter if month/year provided
    let dateFilter = null;
    try {
      dateFilter = createMonthFilter(month, year);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    // Get enrollment count (with optional group filter)
    let enrollmentQuery = supabase
      .from("enrollments")
      .select("*", { count: "exact", head: true })
      .eq("course_id", parseInt(courseId))
      .eq("status", "active");

    if (groupId && groupStudentIds && groupStudentIds.length > 0) {
      enrollmentQuery = enrollmentQuery.in("student_id", groupStudentIds);
    }

    const { count: enrollmentCount, error: enrollError } = await enrollmentQuery;
    if (enrollError) throw enrollError;

    // Get activities count (always total)
    const { count: activitiesCount, error: activitiesError } = await supabase
      .from("activities")
      .select("*", { count: "exact", head: true })
      .eq("course_id", parseInt(courseId));

    if (activitiesError) throw activitiesError;

    // Get trackable activities count (always total)
    const { count: trackableCount, error: trackableError } = await supabase
      .from("activities")
      .select("*", { count: "exact", head: true })
      .eq("course_id", parseInt(courseId))
      .eq("has_completion", true);

    if (trackableError) throw trackableError;

    // === GET GROUPS FOR THIS COURSE ===
    const { data: groups, error: groupsError } = await supabase
      .from("groups")
      .select("group_id, group_name, description")
      .eq("course_id", parseInt(courseId))
      .order("group_name");

    // Get member counts for each group
    const groupsWithCounts = await Promise.all(
      (groups || []).map(async (group) => {
        const { count, error } = await supabase
          .from("group_members")
          .select("*", { count: "exact", head: true })
          .eq("group_id", group.group_id)
          .eq("course_id", parseInt(courseId));

        return {
          ...group,
          member_count: count || 0,
        };
      })
    );

    // === FILTERED DATA (if dateFilter or group filter exists) ===

    // Get activity completions with optional filters
    let completionQuery = supabase
      .from("activity_completions")
      .select("student_id, activity_id, is_completed, time_completed")
      .eq("course_id", parseInt(courseId))
      .eq("is_completed", true);

    // Apply date filter
    if (dateFilter) {
      completionQuery = completionQuery
        .gte("time_completed", dateFilter.startDate)
        .lte("time_completed", dateFilter.endDate)
        .not("time_completed", "is", null);
    }

    // Apply group filter
    if (groupId && groupStudentIds && groupStudentIds.length > 0) {
      completionQuery = completionQuery.in("student_id", groupStudentIds);
    }

    const { data: completionData, error: completionError } = await completionQuery;
    if (completionError) throw completionError;

    // Calculate unique students and activities that had completions in the period
    const uniqueStudentsWithCompletions = new Set(
      completionData.map((c) => c.student_id)
    ).size;

    const uniqueActivitiesCompleted = new Set(
      completionData.map((c) => c.activity_id)
    ).size;

    const totalCompletionsInPeriod = completionData.length;

    // Get course completion stats with optional filters
    let courseCompletionQuery = supabase
      .from("course_completions")
      .select(
        "completion_percentage, is_course_completed, student_id, completion_date"
      )
      .eq("course_id", parseInt(courseId));

    // Apply date filter
    if (dateFilter) {
      courseCompletionQuery = courseCompletionQuery
        .gte("completion_date", dateFilter.startDate)
        .lte("completion_date", dateFilter.endDate)
        .eq("is_course_completed", true)
        .not("completion_date", "is", null);
    }

    // Apply group filter
    if (groupId && groupStudentIds && groupStudentIds.length > 0) {
      courseCompletionQuery = courseCompletionQuery.in("student_id", groupStudentIds);
    }

    const { data: completionStats, error: statsError } = await courseCompletionQuery;
    if (statsError) throw statsError;

    // Calculate average completion percentage
    const avgCompletion =
      completionStats.length > 0
        ? completionStats.reduce(
            (sum, s) => sum + parseFloat(s.completion_percentage),
            0
          ) / completionStats.length
        : 0;

    const completedStudents = completionStats.filter(
      (s) => s.is_course_completed
    ).length;

    // Determine what type of filter is applied
    const hasDateFilter = !!dateFilter;
    const hasGroupFilter = !!groupId;
    const hasAnyFilter = hasDateFilter || hasGroupFilter;

    // Build response
    const response = {
      success: true,
      course: {
        ...courseData,
        // TOTAL COUNTS (may be filtered by group)
        enrolled_students: enrollmentCount,
        total_activities: activitiesCount,
        trackable_activities: trackableCount,
        groups: groupsWithCounts,
        has_groups: (groupsWithCounts || []).length > 0,
      },
      filters: {
        month: month || null,
        year: year || null,
        groupId: groupId || null,
        applied: hasAnyFilter,
        description: getFilterDescription(month, year, groupId, groupInfo),
      },
    };

    // If group filter is applied, add group info
    if (hasGroupFilter && groupInfo) {
      response.group = {
        ...groupInfo,
        student_count: groupStudentIds?.length || 0,
      };
    }

    // Add filtered stats if any filter is applied
    if (hasAnyFilter) {
      response.filtered_stats = {
        unique_students_active: uniqueStudentsWithCompletions,
        unique_activities_completed: uniqueActivitiesCompleted,
        total_completions: totalCompletionsInPeriod,
        students_who_completed_course: completedStudents,
        avg_completion_percentage: parseFloat(avgCompletion.toFixed(2)),
        period: dateFilter ? `${dateFilter.month}/${dateFilter.year}` : null,
        filter_type: getFilterType(hasDateFilter, hasGroupFilter),
      };
    } else {
      // If no filter, show overall completion stats
      response.overall_stats = {
        avg_completion_percentage: parseFloat(avgCompletion.toFixed(2)),
        students_completed: completedStudents,
      };
    }

    // Helper function to get filter description
    function getFilterDescription(month, year, groupId, groupInfo) {
      const parts = [];
      
      if (month && year) {
        parts.push(`for ${month}/${year}`);
      }
      
      if (groupId && groupInfo) {
        parts.push(`in group "${groupInfo.group_name}"`);
      }
      
      if (parts.length === 0) {
        return "Showing all data";
      }
      
      return `Showing data ${parts.join(" ")}`;
    }

    // Helper function to get filter type
    function getFilterType(hasDateFilter, hasGroupFilter) {
      if (hasDateFilter && hasGroupFilter) return "monthly_group";
      if (hasDateFilter) return "monthly";
      if (hasGroupFilter) return "group";
      return "none";
    }

    res.json(response);
  } catch (error) {
    console.error("Error fetching course details:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 3: GET STUDENTS ENROLLED IN A COURSE (WITH MONTHLY FILTER)
// ============================================================================

app.get("/api/courses/:courseId/students", async (req, res) => {
  try {
    const { courseId } = req.params;
    const { status, search, page = 1, limit = 50, month, year } = req.query;

    // Create date filter if month/year provided
    let dateFilter = null;
    try {
      dateFilter = createMonthFilter(month, year);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    // If monthly filter is applied, get students who had completions in that period
    let studentIds = null;
    if (dateFilter) {
      const { data: completionsInPeriod, error: compError } = await supabase
        .from("activity_completions")
        .select("student_id")
        .eq("course_id", parseInt(courseId))
        .gte("time_completed", dateFilter.startDate)
        .lte("time_completed", dateFilter.endDate)
        .eq("is_completed", true)
        .not("time_completed", "is", null);

      if (compError) throw compError;

      studentIds = [
        ...new Set(completionsInPeriod?.map((c) => c.student_id) || []),
      ];

      // If no students had completions in this period, return empty result
      if (studentIds.length === 0) {
        return res.json({
          success: true,
          students: [],
          pagination: {
            total: 0,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: 0,
          },
          filters: {
            month: month,
            year: year,
            applied: true,
            message: `No students had activity completions in ${dateFilter.month}/${dateFilter.year}`,
          },
        });
      }
    }

    let query = supabase
      .from("student_course_progress")
      .select("*", { count: "exact" })
      .eq("course_id", parseInt(courseId));

    // Filter by student IDs if monthly filter is applied
    if (studentIds) {
      query = query.in("student_id", studentIds);
    }

    if (status) {
      if (status === "completed") {
        query = query.eq("is_course_completed", true);
      } else if (status === "incomplete") {
        query = query.eq("is_course_completed", false);
      }
    }

    if (search) {
      query = query.or(
        `student_name.ilike.%${search}%,student_email.ilike.%${search}%`
      );
    }

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query.order("student_name");

    if (error) throw error;

    // If monthly filter is applied, add completion counts for the period
    if (dateFilter && data.length > 0) {
      const studentIdsInResults = data.map((s) => s.student_id);

      // Get completion counts for each student in the period
      const { data: monthlyCompletions, error: mcError } = await supabase
        .from("activity_completions")
        .select("student_id, activity_id, is_completed")
        .eq("course_id", parseInt(courseId))
        .in("student_id", studentIdsInResults)
        .gte("time_completed", dateFilter.startDate)
        .lte("time_completed", dateFilter.endDate)
        .eq("is_completed", true)
        .not("time_completed", "is", null);

      if (!mcError) {
        // Count completions per student
        const completionCounts = {};
        monthlyCompletions.forEach((c) => {
          completionCounts[c.student_id] =
            (completionCounts[c.student_id] || 0) + 1;
        });

        // Add monthly completion data to each student
        data.forEach((student) => {
          student.monthly_completions =
            completionCounts[student.student_id] || 0;
        });
      }
    }

    res.json({
      success: true,
      students: data,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / parseInt(limit)),
      },
      filters: {
        month: month || null,
        year: year || null,
        applied: !!dateFilter,
        description: dateFilter
          ? `Showing students who completed activities in ${dateFilter.month}/${dateFilter.year}`
          : "Showing all enrolled students",
      },
    });
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 4: GET ACTIVITIES/CLASSES IN A COURSE
// Per Course: Which Classes Are Completed
// ============================================================================

app.get("/api/courses/:courseId/activities", async (req, res) => {
  try {
    const { courseId } = req.params;
    const { sectionNumber, activityType, hasCompletion } = req.query;

    let query = supabase
      .from("activity_completion_by_course")
      .select("*")
      .eq("course_id", parseInt(courseId));

    if (sectionNumber) {
      query = query.eq("section_number", parseInt(sectionNumber));
    }

    if (activityType && activityType !== "all") {
      query = query.eq("activity_type", activityType);
    }

    const { data, error } = await query
      .order("section_number")
      .order("activity_name");

    if (error) throw error;

    // Group by sections
    const sections = {};
    data.forEach((activity) => {
      const sectionKey = activity.section_number;
      if (!sections[sectionKey]) {
        sections[sectionKey] = {
          section_number: activity.section_number,
          section_name: activity.section_name,
          activities: [],
        };
      }
      sections[sectionKey].activities.push(activity);
    });

    res.json({
      success: true,
      activities: data,
      sections: Object.values(sections),
    });
  } catch (error) {
    console.error("Error fetching activities:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 5: GET STUDENT PROGRESS IN A COURSE
// Individual Student: Which Classes Completed
// ============================================================================

app.get(
  "/api/courses/:courseId/students/:studentId/progress",
  async (req, res) => {
    try {
      const { courseId, studentId } = req.params;
      const { month, year } = req.query;

      // Create date filter if month/year provided
      let dateFilter = null;
      try {
        dateFilter = createMonthFilter(month, year);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      // Get student enrollment info
      const { data: enrollment, error: enrollError } = await supabase
        .from("enrollments")
        .select("*")
        .eq("course_id", parseInt(courseId))
        .eq("student_id", parseInt(studentId))
        .single();

      if (enrollError) throw enrollError;

      if (!enrollment) {
        return res.status(404).json({
          success: false,
          error: "Student not enrolled in this course",
        });
      }

      // Get all activities in the course
      const { data: activities, error: activitiesError } = await supabase
        .from("activities")
        .select("*")
        .eq("course_id", parseInt(courseId))
        .eq("has_completion", true);

      if (activitiesError) throw activitiesError;

      // Get student's completions (with optional date filter)
      let completionsQuery = supabase
        .from("activity_completions")
        .select("*")
        .eq("course_id", parseInt(courseId))
        .eq("student_id", parseInt(studentId));

      if (dateFilter) {
        completionsQuery = completionsQuery
          .gte("time_completed", dateFilter.startDate)
          .lte("time_completed", dateFilter.endDate)
          .not("time_completed", "is", null);
      }

      const { data: completions, error: completionsError } =
        await completionsQuery;

      if (completionsError) throw completionsError;

      // Create completion map
      const completionMap = {};
      completions.forEach((c) => {
        completionMap[c.activity_id] = c;
      });

      // Combine activities with completion status
      const activitiesWithCompletion = activities.map((activity) => ({
        ...activity,
        completion: completionMap[activity.activity_id] || {
          is_completed: false,
          is_passed: false,
          is_failed: false,
          time_completed: null,
        },
      }));

      // Group by sections
      const sections = {};
      activitiesWithCompletion.forEach((activity) => {
        const sectionKey = activity.section_number;
        if (!sections[sectionKey]) {
          sections[sectionKey] = {
            section_number: activity.section_number,
            section_name: activity.section_name,
            activities: [],
            total: 0,
            completed: 0,
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
      const completedActivities = completions.filter(
        (c) => c.is_completed
      ).length;
      const passedActivities = completions.filter((c) => c.is_passed).length;
      const failedActivities = completions.filter((c) => c.is_failed).length;

      const response = {
        success: true,
        student: enrollment,
        summary: {
          total_activities: totalActivities,
          completed_activities: completedActivities,
          passed_activities: passedActivities,
          failed_activities: failedActivities,
          completion_percentage:
            totalActivities > 0
              ? ((completedActivities / totalActivities) * 100).toFixed(2)
              : 0,
        },
        sections: Object.values(sections).sort(
          (a, b) => a.section_number - b.section_number
        ),
        activities: activitiesWithCompletion,
        filters: {
          month: month || null,
          year: year || null,
          applied: !!dateFilter,
          description: dateFilter
            ? `Showing activities completed in ${dateFilter.month}/${dateFilter.year}`
            : "Showing all activities with current completion status",
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching student progress:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ============================================================================
// ENDPOINT 6: GET COMPLETION STATISTICS FOR A COURSE (WITH MONTHLY & GROUP FILTER)
// ============================================================================

app.get("/api/courses/:courseId/stats", async (req, res) => {
  try {
    const { courseId } = req.params;
    const { month, year, groupId } = req.query;

    // Create date filter if month/year provided
    let dateFilter = null;
    try {
      dateFilter = createMonthFilter(month, year);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    // Get student IDs for group filter if groupId is provided
    let groupStudentIds = null;
    let groupInfo = null;
    
    if (groupId) {
      // Get group information
      const { data: groupData, error: groupError } = await supabase
        .from("groups")
        .select("*")
        .eq("course_id", parseInt(courseId))
        .eq("group_id", parseInt(groupId))
        .single();

      if (groupError) throw groupError;
      
      if (!groupData) {
        return res.status(404).json({
          success: false,
          error: "Group not found in this course",
        });
      }

      groupInfo = {
        group_id: groupData.group_id,
        group_name: groupData.group_name,
        description: groupData.description
      };

      // Get student IDs in this group
      const { data: groupMembers, error: membersError } = await supabase
        .from("group_members")
        .select("student_id")
        .eq("course_id", parseInt(courseId))
        .eq("group_id", parseInt(groupId));

      if (membersError) throw membersError;

      groupStudentIds = groupMembers?.map(m => m.student_id) || [];
    }

    // Get overall stats from view (unfiltered baseline)
    const { data: stats, error: statsError } = await supabase
      .from("course_completion_stats")
      .select("*")
      .eq("course_id", parseInt(courseId))
      .single();

    if (statsError) throw statsError;

    // Get activities with completion data
    const { data: activities, error: activitiesError } = await supabase
      .from("activity_completion_by_course")
      .select("*")
      .eq("course_id", parseInt(courseId));

    if (activitiesError) throw activitiesError;

    // If monthly filter OR group filter is applied, we need to recalculate stats
    let filteredStats = null;
    let filteredByType = null;
    let filteredBySection = null;
    let recalculatedStats = null;

    const hasDateFilter = !!dateFilter;
    const hasGroupFilter = !!groupId;
    const hasAnyFilter = hasDateFilter || hasGroupFilter;

    if (hasAnyFilter) {
      // Build query for filtered completions
      let completionsQuery = supabase
        .from("activity_completions")
        .select("activity_id, student_id, is_completed, is_passed, is_failed, time_completed")
        .eq("course_id", parseInt(courseId));

      // Apply date filter
      if (hasDateFilter) {
        completionsQuery = completionsQuery
          .gte("time_completed", dateFilter.startDate)
          .lte("time_completed", dateFilter.endDate)
          .not("time_completed", "is", null);
      }

      // Apply group filter
      if (hasGroupFilter && groupStudentIds && groupStudentIds.length > 0) {
        completionsQuery = completionsQuery.in("student_id", groupStudentIds);
      }

      const { data: filteredCompletions, error: fcError } = await completionsQuery;
      if (fcError) throw fcError;

      // Calculate filtered statistics
      const totalCompletions = filteredCompletions?.filter(
        (c) => c.is_completed
      ).length || 0;
      const totalPassed = filteredCompletions?.filter((c) => c.is_passed).length || 0;
      const totalFailed = filteredCompletions?.filter((c) => c.is_failed).length || 0;
      const uniqueStudents = new Set(
        filteredCompletions?.map((c) => c.student_id) || []
      ).size;
      const uniqueActivities = new Set(
        filteredCompletions?.map((c) => c.activity_id) || []
      ).size;

      recalculatedStats = {
        total_completions: totalCompletions,
        total_passed: totalPassed,
        total_failed: totalFailed,
        unique_students: uniqueStudents,
        unique_activities: uniqueActivities,
        avg_completions_per_student:
          uniqueStudents > 0
            ? (totalCompletions / uniqueStudents).toFixed(2)
            : 0,
      };

      // Calculate filtered stats by activity type
      const completionsByActivity = {};
      filteredCompletions?.forEach((c) => {
        completionsByActivity[c.activity_id] =
          (completionsByActivity[c.activity_id] || 0) + 1;
      });

      filteredByType = {};
      activities.forEach((activity) => {
        const completionCount =
          completionsByActivity[activity.activity_id] || 0;

        if (!filteredByType[activity.activity_type]) {
          filteredByType[activity.activity_type] = {
            total_activities: 0,
            activities_with_completions: 0,
            total_completions: 0,
            avg_completion_rate: 0,
          };
        }

        filteredByType[activity.activity_type].total_activities++;
        if (completionCount > 0) {
          filteredByType[activity.activity_type].activities_with_completions++;
          filteredByType[activity.activity_type].total_completions +=
            completionCount;
        }
      });

      // Calculate average completion rate per type for filtered data
      Object.keys(filteredByType).forEach((type) => {
        const typeActivities = activities.filter(a => a.activity_type === type);
        const totalStudents = hasGroupFilter ? 
          (groupStudentIds?.length || 0) : 
          (stats?.enrolled_students || 0);
        
        if (totalStudents > 0) {
          const avgRate = (filteredByType[type].total_completions / (totalStudents * filteredByType[type].total_activities)) * 100;
          filteredByType[type].avg_completion_rate = avgRate.toFixed(2);
        }
      });

      // Calculate filtered stats by section
      filteredBySection = {};
      activities.forEach((activity) => {
        const completionCount =
          completionsByActivity[activity.activity_id] || 0;
        const key = activity.section_number;

        if (!filteredBySection[key]) {
          filteredBySection[key] = {
            section_number: activity.section_number,
            section_name: activity.section_name,
            total_activities: 0,
            activities_with_completions: 0,
            total_completions: 0,
            avg_completion_rate: 0,
          };
        }

        filteredBySection[key].total_activities++;
        if (completionCount > 0) {
          filteredBySection[key].activities_with_completions++;
          filteredBySection[key].total_completions += completionCount;
        }
      });

      // Calculate average completion rate per section for filtered data
      Object.keys(filteredBySection).forEach((key) => {
        const totalStudents = hasGroupFilter ? 
          (groupStudentIds?.length || 0) : 
          (stats?.enrolled_students || 0);
        
        if (totalStudents > 0) {
          const avgRate = (filteredBySection[key].total_completions / (totalStudents * filteredBySection[key].total_activities)) * 100;
          filteredBySection[key].avg_completion_rate = avgRate.toFixed(2);
        }
      });
    }

    // Group by activity type (baseline - unfiltered)
    const byType = {};
    activities.forEach((activity) => {
      if (!byType[activity.activity_type]) {
        byType[activity.activity_type] = {
          total: 0,
          avg_completion_rate: parseFloat(activity.completion_rate || 0).toFixed(2),
          activities: [],
        };
      }
      byType[activity.activity_type].total++;
      byType[activity.activity_type].activities.push(activity);
    });

    // Calculate average completion rate per type (unfiltered)
    Object.keys(byType).forEach((type) => {
      const typeActivities = activities.filter(a => a.activity_type === type);
      const totalCompletionRate = typeActivities.reduce(
        (sum, a) => sum + parseFloat(a.completion_rate || 0),
        0
      );
      byType[type].avg_completion_rate = 
        typeActivities.length > 0 ? (totalCompletionRate / typeActivities.length).toFixed(2) : "0.00";
    });

    // Get completion by section (baseline - unfiltered)
    const bySection = {};
    activities.forEach((activity) => {
      const key = activity.section_number;
      if (!bySection[key]) {
        bySection[key] = {
          section_number: activity.section_number,
          section_name: activity.section_name,
          total_activities: 0,
          avg_completion_rate: parseFloat(activity.completion_rate || 0).toFixed(2),
          activities: [],
        };
      }
      bySection[key].total_activities++;
      bySection[key].activities.push(activity);
    });

    // Calculate average completion rate per section (unfiltered)
    Object.keys(bySection).forEach((key) => {
      const sectionActivities = activities.filter(a => a.section_number === parseInt(key));
      const totalCompletionRate = sectionActivities.reduce(
        (sum, a) => sum + parseFloat(a.completion_rate || 0),
        0
      );
      bySection[key].avg_completion_rate = 
        sectionActivities.length > 0 ? (totalCompletionRate / sectionActivities.length).toFixed(2) : "0.00";
    });

    // Build response
    const response = {
      success: true,
      stats: {
        ...stats,
        by_activity_type: byType,
        by_section: Object.values(bySection).sort(
          (a, b) => a.section_number - b.section_number
        ),
      },
      filters: {
        month: month || null,
        year: year || null,
        groupId: groupId || null,
        applied: hasAnyFilter,
        description: getFilterDescription(month, year, groupId, groupInfo),
      },
    };

    // Add filtered stats if any filter is applied
    if (hasAnyFilter) {
      response.filtered_stats = {
        ...recalculatedStats,
        by_activity_type: filteredByType,
        by_section: Object.values(filteredBySection || {}).sort(
          (a, b) => a.section_number - b.section_number
        ),
        period: dateFilter ? `${dateFilter.month}/${dateFilter.year}` : null,
        group: groupInfo ? {
          group_id: groupInfo.group_id,
          group_name: groupInfo.group_name,
          student_count: groupStudentIds?.length || 0
        } : null,
        filter_type: getFilterType(hasDateFilter, hasGroupFilter),
      };
    }

    // Helper function to get filter description
    function getFilterDescription(month, year, groupId, groupInfo) {
      const parts = [];
      
      if (month && year) {
        parts.push(`for ${month}/${year}`);
      }
      
      if (groupId && groupInfo) {
        parts.push(`in group "${groupInfo.group_name}"`);
      }
      
      if (parts.length === 0) {
        return "Showing all data";
      }
      
      return `Showing data ${parts.join(" ")}`;
    }

    // Helper function to get filter type
    function getFilterType(hasDateFilter, hasGroupFilter) {
      if (hasDateFilter && hasGroupFilter) return "monthly_group";
      if (hasDateFilter) return "monthly";
      if (hasGroupFilter) return "group";
      return "none";
    }

    res.json(response);
  } catch (error) {
    console.error("Error fetching course stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 7: FILTER STUDENTS BY COMPLETION CRITERIA
// ============================================================================

app.get("/api/students/filter", async (req, res) => {
  try {
    const {
      courseId,
      minCompletion,
      maxCompletion,
      isCompleted,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    let query = supabase
      .from("student_course_progress")
      .select("*", { count: "exact" });

    if (courseId) {
      query = query.eq("course_id", parseInt(courseId));
    }

    if (minCompletion) {
      query = query.gte("completion_percentage", parseFloat(minCompletion));
    }

    if (maxCompletion) {
      query = query.lte("completion_percentage", parseFloat(maxCompletion));
    }

    if (isCompleted !== undefined) {
      query = query.eq("is_course_completed", isCompleted === "true");
    }

    if (search) {
      query = query.or(
        `student_name.ilike.%${search}%,student_email.ilike.%${search}%`
      );
    }

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query.order("completion_percentage", {
      ascending: false,
    });

    if (error) throw error;

    res.json({
      success: true,
      students: data,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error filtering students:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 8: GET FILTER OPTIONS
// ============================================================================

// Get all courses for dropdown
app.get("/api/filters/courses", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("courses")
      .select("course_id, short_name, full_name, visible")
      .eq("visible", true)
      .order("full_name");

    if (error) throw error;

    res.json({ success: true, courses: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get activity types for a course
app.get("/api/filters/activity-types", async (req, res) => {
  try {
    const { courseId } = req.query;

    let query = supabase.from("activities").select("activity_type");

    if (courseId) {
      query = query.eq("course_id", parseInt(courseId));
    }

    const { data, error } = await query;

    if (error) throw error;

    const uniqueTypes = [
      ...new Set(data.map((item) => item.activity_type)),
    ].sort();

    res.json({ success: true, activityTypes: uniqueTypes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get sections for a course
app.get("/api/filters/sections", async (req, res) => {
  try {
    const { courseId } = req.query;

    if (!courseId) {
      return res.status(400).json({
        success: false,
        error: "courseId is required",
      });
    }

    const { data, error } = await supabase
      .from("activities")
      .select("section_number, section_name")
      .eq("course_id", parseInt(courseId));

    if (error) throw error;

    const uniqueSections = [
      ...new Map(
        data.map((item) => [
          item.section_number,
          {
            number: item.section_number,
            name: item.section_name,
          },
        ])
      ).values(),
    ].sort((a, b) => a.number - b.number);

    res.json({ success: true, sections: uniqueSections });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT 9: EXPORT DATA
// ============================================================================

app.get("/api/export/course/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;
    const { format = "students" } = req.query;

    let data, headers;

    if (format === "students") {
      // Export student progress
      const { data: students, error } = await supabase
        .from("student_course_progress")
        .select("*")
        .eq("course_id", parseInt(courseId));

      if (error) throw error;
      data = students;
      headers = [
        "student_id",
        "student_name",
        "student_email",
        "total_activities",
        "completed_activities",
        "completion_percentage",
        "is_course_completed",
      ];
    } else if (format === "activities") {
      // Export activities
      const { data: activities, error } = await supabase
        .from("activity_completion_by_course")
        .select("*")
        .eq("course_id", parseInt(courseId));

      if (error) throw error;
      data = activities;
      headers = [
        "activity_id",
        "activity_name",
        "activity_type",
        "section_name",
        "total_students",
        "students_completed",
        "completion_rate",
      ];
    }

    if (!data || data.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "No data to export" });
    }

    // Create CSV
    const csvHeaders = headers.join(",");
    const csvRows = data.map((row) =>
      headers
        .map((header) => {
          const val = row[header];
          return typeof val === "string" && val.includes(",")
            ? `"${val}"`
            : val;
        })
        .join(",")
    );

    const csv = [csvHeaders, ...csvRows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=course_${courseId}_${format}.csv`
    );
    res.send(csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// GET COURSE GROUPS WITH DETAILS
// ============================================================================
app.get("/api/courses/:courseId/groups-summary", async (req, res) => {
  try {
    const { courseId } = req.params;

    // Get groups with member counts
    const { data: groups, error: groupsError } = await supabase
      .from("groups")
      .select(`
        *,
        group_members!left (student_id)
      `)
      .eq("course_id", parseInt(courseId))
      .order("group_name");

    if (groupsError) throw groupsError;

    // Calculate member counts for each group
    const groupsWithCounts = groups.map(group => {
      // Count unique student IDs
      const memberCount = new Set(
        group.group_members?.map(m => m.student_id) || []
      ).size;

      return {
        group_id: group.group_id,
        group_name: group.group_name,
        description: group.description,
        member_count: memberCount,
        created_at: group.created_at,
        updated_at: group.updated_at
      };
    });

    // Get course details
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("course_id, short_name, full_name")
      .eq("course_id", parseInt(courseId))
      .single();

    if (courseError) throw courseError;

    res.json({
      success: true,
      course: {
        course_id: course.course_id,
        name: course.full_name,
        short_name: course.short_name
      },
      groups: groupsWithCounts,
      total_groups: groupsWithCounts.length,
      total_members: groupsWithCounts.reduce((sum, g) => sum + g.member_count, 0)
    });
  } catch (error) {
    console.error("Error fetching course groups summary:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ENDPOINT: GET ALL GROUPS FOR FILTERING (FIXED VERSION)
// ============================================================================
app.get("/api/filters/groups", async (req, res) => {
  try {
    const { courseId } = req.query;

    // Step 1: Get groups
    let groupsQuery = supabase
      .from("groups")
      .select("group_id, group_name, description, course_id")
      .order("group_name");

    if (courseId) {
      groupsQuery = groupsQuery.eq("course_id", parseInt(courseId));
    }

    const { data: groups, error: groupsError } = await groupsQuery;
    if (groupsError) throw groupsError;

    if (!groups || groups.length === 0) {
      return res.json({
        success: true,
        groups: [],
        total: 0
      });
    }

    // Step 2: Get course details for these groups
    const courseIds = [...new Set(groups.map(g => g.course_id))];
    const { data: courses, error: coursesError } = await supabase
      .from("courses")
      .select("course_id, short_name, full_name")
      .in("course_id", courseIds);

    if (coursesError) throw coursesError;

    // Create a map of course_id -> course details
    const courseMap = {};
    if (courses) {
      courses.forEach(course => {
        courseMap[course.course_id] = {
          short_name: course.short_name,
          full_name: course.full_name
        };
      });
    }

    // Step 3: Format the response
    const formattedGroups = groups.map(group => {
      const courseInfo = courseMap[group.course_id] || {};
      
      return {
        value: group.group_id,
        label: `${group.group_name} (${courseInfo.short_name || courseInfo.full_name || `Course ${group.course_id}`})`,
        group_id: group.group_id,
        group_name: group.group_name,
        description: group.description || "",
        course_id: group.course_id,
        course_name: courseInfo.full_name || courseInfo.short_name || `Course ${group.course_id}`,
        course_short_name: courseInfo.short_name || ""
      };
    });

    res.json({ 
      success: true, 
      groups: formattedGroups,
      total: formattedGroups.length 
    });
  } catch (error) {
    console.error("Error fetching groups for filters:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
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
          moodlewsrestformat: "json",
          ...params,
        },
        timeout: 30000,
      });

      if (response.data.exception) {
        throw new Error(response.data.message || "Moodle API Error");
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
    return await this.callFunction("core_course_get_courses");
  }

  /**
   * Get enrolled users in a course
   */
  async getEnrolledUsers(courseId) {
    return await this.callFunction("core_enrol_get_enrolled_users", {
      courseid: courseId,
    });
  }

  /**
   * Get course contents (sections and activities)
   */
  async getCourseContents(courseId) {
    return await this.callFunction("core_course_get_contents", {
      courseid: courseId,
    });
  }

  /**
   * Get course completion status for a user
   */
  async getCourseCompletionStatus(courseId, userId) {
    return await this.callFunction(
      "core_completion_get_course_completion_status",
      {
        courseid: courseId,
        userid: userId,
      }
    );
  }

  /**
   * Get activities completion status for a user
   */
  async getActivitiesCompletionStatus(courseId, userId) {
    return await this.callFunction(
      "core_completion_get_activities_completion_status",
      {
        courseid: courseId,
        userid: userId,
      }
    );
  }

  /**
   * Get all groups in a course
   */
  async getCourseGroups(courseId) {
    return await this.callFunction("core_group_get_course_groups", {
      courseid: courseId,
    });
  }

  /**
   * Get members of a specific group
   */
  async getGroupMembers(groupId) {
    console.log(
      `   ⚠ getGroupMembers: Function not available, returning empty array`
    );
    return await this.callFunction("core_group_get_group_members", {
      groupid: groupId,
    });
  }
}

// ============================================================================
// ENDPOINT: SYNC SINGLE COURSE FROM MOODLE TO SUPABASE
// ============================================================================

app.post("/api/moodle/sync/course/:courseId", async (req, res) => {
  const startTime = Date.now();
  const { courseId } = req.params;

  console.log("\n" + "=".repeat(80));
  console.log(` STARTING MOODLE SYNC FOR COURSE ${courseId}`);
  console.log("=".repeat(80));

  try {
    const moodle = new MoodleAPIClient(
      process.env.MOODLE_URL,
      process.env.MOODLE_TOKEN
    );

    const syncResults = {
      course: { success: 0, failed: 0 },
      enrollments: { success: 0, failed: 0 },
      activities: { success: 0, failed: 0 },
      completions: { success: 0, failed: 0 },
      courseCompletions: { success: 0, failed: 0 },
      groups: { success: 0, failed: 0 },
      groupMembers: { success: 0, failed: 0 },
      errors: [],
    };

    // ========================================================================
    // STEP 1: Fetch and Save Course Information
    // ========================================================================
    console.log("\n📚 Step 1/6: Fetching course information...");

    const courses = await moodle.getCourses();
    const course = courses.find((c) => c.id === parseInt(courseId));

    if (!course) {
      return res.status(404).json({
        success: false,
        error: `Course ${courseId} not found`,
      });
    }

    console.log(`   ✓ Found: ${course.fullname}`);

    const courseData = {
      course_id: course.id,
      short_name: course.shortname,
      full_name: course.fullname,
      category_id: course.categoryid || 0,
      category_name: null,
      summary: course.summary || "",
      format: course.format || "topics",
      start_date: course.startdate ? new Date(course.startdate * 1000) : null,
      end_date: course.enddate ? new Date(course.enddate * 1000) : null,
      visible: course.visible === 1,
      updated_at: new Date(),
    };

    const { error: courseError } = await supabase
      .from("courses")
      .upsert([courseData], { onConflict: "course_id" });

    if (courseError) {
      console.error("   ✗ Error saving course:", courseError.message);
      syncResults.course.failed = 1;
      syncResults.errors.push(`Course: ${courseError.message}`);
    } else {
      console.log("   ✓ Course saved to Supabase");
      syncResults.course.success = 1;
    }

    // ========================================================================
    // STEP 2: Fetch and Save Enrolled Students
    // ========================================================================
    console.log("\n👥 Step 2/6: Fetching enrolled students...");

    const enrolledUsers = await moodle.getEnrolledUsers(courseId);
    console.log(`   ✓ Found ${enrolledUsers.length} enrolled users`);

    const students = enrolledUsers.filter(
      (user) =>
        user.roles &&
        user.roles.some(
          (role) => role.shortname === "student" || role.roleid === 5
        )
    );

    console.log(`   ✓ Filtered to ${students.length} students`);

    if (students.length > 0) {
      const enrollmentsData = students.map((student) => ({
        course_id: parseInt(courseId),
        student_id: student.id,
        student_name: `${student.firstname} ${student.lastname}`,
        student_email: student.email || "",
        student_first_name: student.firstname,
        student_last_name: student.lastname,
        enrollment_date: student.firstaccess
          ? new Date(student.firstaccess * 1000)
          : new Date(),
        role: "student",
        status: "active",
        updated_at: new Date(),
      }));

      const { error: enrollError } = await supabase
        .from("enrollments")
        .upsert(enrollmentsData, { onConflict: "course_id,student_id" });

      if (enrollError) {
        console.error("   ✗ Error saving enrollments:", enrollError.message);
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
    console.log("\n📝 Step 3/6: Fetching course content and activities...");

    const courseContents = await moodle.getCourseContents(courseId);
    console.log(`   ✓ Found ${courseContents.length} sections`);

    const allActivities = [];
    courseContents.forEach((section) => {
      if (section.modules && section.modules.length > 0) {
        section.modules.forEach((module) => {
          allActivities.push({
            course_id: parseInt(courseId),
            activity_id: module.id,
            section_id: section.id,
            section_number: section.section,
            section_name: section.name,
            activity_name: module.name,
            activity_type: module.modname,
            activity_url: module.url || null,
            description: module.description || "",
            visible: module.visible === 1,
            availability_start: null,
            availability_end: null,
            has_completion: (module.completion || 0) > 0,
            completion_expected: module.completionexpected
              ? new Date(module.completionexpected * 1000)
              : null,
            updated_at: new Date(),
          });
        });
      }
    });

    console.log(`   ✓ Found ${allActivities.length} activities`);

    if (allActivities.length > 0) {
      const { error: activitiesError } = await supabase
        .from("activities")
        .upsert(allActivities, { onConflict: "course_id,activity_id" });

      if (activitiesError) {
        console.error("   ✗ Error saving activities:", activitiesError.message);
        syncResults.activities.failed = allActivities.length;
        syncResults.errors.push(`Activities: ${activitiesError.message}`);
      } else {
        console.log(
          `   ✓ Saved ${allActivities.length} activities to Supabase`
        );
        syncResults.activities.success = allActivities.length;
      }
    }

    // ========================================================================
    // STEP 4: Fetch and Save Groups
    // ========================================================================
    console.log("\n👥 Step 4/6: Fetching groups...");

    try {
      const courseGroups = await moodle.getCourseGroups(courseId);
      console.log(`   ✓ Found ${courseGroups.length} groups`);

      if (courseGroups.length > 0) {
        // Save groups
        const groupsData = courseGroups.map((group) => ({
          group_id: group.id,
          course_id: parseInt(courseId),
          group_name: group.name,
          description: group.description || "",
          updated_at: new Date(),
        }));

        const { error: groupsError } = await supabase
          .from("groups")
          .upsert(groupsData, { onConflict: "course_id,group_id" });

        if (groupsError) {
          console.error("   ✗ Error saving groups:", groupsError.message);
          syncResults.groups.failed = courseGroups.length;
          syncResults.errors.push(`Groups: ${groupsError.message}`);
        } else {
          console.log(`   ✓ Saved ${courseGroups.length} groups to Supabase`);
          syncResults.groups.success = courseGroups.length;
        }

        // Note: Group members sync is skipped as it requires additional permissions
        // and the Moodle API function might not be available in all setups
        console.log(
          `   ℹ Group members sync skipped - requires additional permissions`
        );
      } else {
        console.log("   ℹ No groups found in this course");
      }
    } catch (error) {
      console.log(`   ⚠ Warning fetching groups: ${error.message}`);
      // Don't fail the entire sync if groups fail
      syncResults.errors.push(`Groups warning: ${error.message}`);
    }

    // ========================================================================
    // STEP 5: Fetch and Save Activity Completions
    // ========================================================================
    console.log("\n✅ Step 5/6: Fetching completion data for all students...");

    const allCompletions = [];
    let processedStudents = 0;
    let studentsWithCompletions = 0;

    for (const student of students) {
      processedStudents++;
      process.stdout.write(
        `   Processing ${processedStudents}/${students.length}: ${student.firstname} ${student.lastname}\r`
      );

      try {
        const activitiesCompletion = await moodle.getActivitiesCompletionStatus(
          courseId,
          student.id
        );

        if (
          activitiesCompletion.statuses &&
          activitiesCompletion.statuses.length > 0
        ) {
          studentsWithCompletions++;

          activitiesCompletion.statuses.forEach((status) => {
            const activity = allActivities.find(
              (a) => a.activity_id === status.cmid
            );

            allCompletions.push({
              course_id: parseInt(courseId),
              student_id: student.id,
              activity_id: status.cmid,
              activity_name: activity ? activity.activity_name : "",
              activity_type: activity ? activity.activity_type : "",
              completion_state: status.state || 0,
              is_completed: status.state >= 1,
              is_passed: status.state === 2,
              is_failed: status.state === 3,
              time_completed: status.timecompleted
                ? new Date(status.timecompleted * 1000)
                : null,
              tracking_type: status.tracking || 0,
              updated_at: new Date(),
            });
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 100)); // Rate limiting
      } catch (error) {
        if (!error.message.includes("No completion criteria")) {
          console.log(
            `\n   ⚠ Error fetching completions for student ${student.id}: ${error.message}`
          );
          syncResults.errors.push(
            `Student ${student.id} completions: ${error.message}`
          );
        }
      }
    }

    console.log(
      `\n   ✓ Fetched ${allCompletions.length} completion records from ${studentsWithCompletions}/${students.length} students`
    );

    if (allCompletions.length > 0) {
      console.log("   💾 Saving completions to Supabase...");

      const batchSize = 100;
      let savedCount = 0;

      for (let i = 0; i < allCompletions.length; i += batchSize) {
        const batch = allCompletions.slice(i, i + batchSize);

        const { error: completionsError } = await supabase
          .from("activity_completions")
          .upsert(batch, { onConflict: "course_id,student_id,activity_id" });

        if (completionsError) {
          console.error(
            `\n   ✗ Error saving completions batch: ${completionsError.message}`
          );
          syncResults.completions.failed += batch.length;
          syncResults.errors.push(`Completions: ${completionsError.message}`);
        } else {
          savedCount += batch.length;
          syncResults.completions.success += batch.length;
          process.stdout.write(
            `   Saved ${savedCount}/${allCompletions.length} completions\r`
          );
        }
      }
      console.log(`\n   ✓ Saved all completions to Supabase`);
    } else {
      console.log("   ℹ No completion data available");
    }

    // ========================================================================
    // STEP 6: Calculate and Save Course Completions Summary
    // ========================================================================
    console.log("\n📊 Step 6/6: Calculating course completion statistics...");

    const trackableActivities = allActivities.filter((a) => a.has_completion);
    console.log(`   Found ${trackableActivities.length} trackable activities`);

    if (trackableActivities.length > 0) {
      const courseCompletionsData = [];

      for (const student of students) {
        const studentCompletions = allCompletions.filter(
          (c) => c.student_id === student.id && c.is_completed
        );

        const completedCount = studentCompletions.length;
        const totalCount = trackableActivities.length;
        const completionPercentage =
          totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

        const isCourseCompleted = completionPercentage >= 100;

        courseCompletionsData.push({
          course_id: parseInt(courseId),
          student_id: student.id,
          total_activities: totalCount,
          completed_activities: completedCount,
          completion_percentage: parseFloat(completionPercentage.toFixed(2)),
          is_course_completed: isCourseCompleted,
          completion_date:
            isCourseCompleted && studentCompletions.length > 0
              ? studentCompletions[studentCompletions.length - 1].time_completed
              : null,
          updated_at: new Date(),
        });
      }

      const { error: ccError } = await supabase
        .from("course_completions")
        .upsert(courseCompletionsData, { onConflict: "course_id,student_id" });

      if (ccError) {
        console.error("   ✗ Error saving course completions:", ccError.message);
        syncResults.courseCompletions.failed = students.length;
        syncResults.errors.push(`CourseCompletions: ${ccError.message}`);
      } else {
        console.log(
          `   ✓ Saved course completion stats for ${students.length} students`
        );
        syncResults.courseCompletions.success = students.length;
      }
    } else {
      console.log("   ℹ Skipping course completions (no trackable activities)");
    }

    // ========================================================================
    // FINAL RESULTS
    // ========================================================================
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("\n" + "=".repeat(80));
    console.log("✅ SYNC COMPLETED SUCCESSFULLY!");
    console.log("=".repeat(80));
    console.log(` Processing Time: ${processingTime}s`);
    console.log(` Course: ${syncResults.course.success} saved`);
    console.log(` Enrollments: ${syncResults.enrollments.success} saved`);
    console.log(` Activities: ${syncResults.activities.success} saved`);
    console.log(` Groups: ${syncResults.groups.success} saved`);
    console.log(` Completions: ${syncResults.completions.success} saved`);
    console.log(
      ` Course Stats: ${syncResults.courseCompletions.success} saved`
    );

    if (syncResults.errors.length > 0) {
      console.log(`\n⚠ Errors encountered:`);
      syncResults.errors.forEach((err) => console.log(`   - ${err}`));
    }
    console.log("=".repeat(80) + "\n");

    res.json({
      success: true,
      message: `Course ${courseId} synced successfully`,
      courseInfo: {
        id: course.id,
        name: course.fullname,
        shortname: course.shortname,
      },
      results: syncResults,
      processingTime: `${processingTime}s`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("\n❌ SYNC FAILED:", error.message);
    console.error(error.stack);

    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// ============================================================================
// ENDPOINT: SYNC ALL VISIBLE COURSES FROM MOODLE
// ============================================================================

app.post("/api/moodle/sync/all-courses", async (req, res) => {
  console.log("\n Starting sync for ALL courses...");

  try {
    const moodle = new MoodleAPIClient(
      process.env.MOODLE_URL,
      process.env.MOODLE_TOKEN
    );

    const courses = await moodle.getCourses();
    const visibleCourses = courses.filter((c) => c.visible === 1 && c.id > 1); // Skip site course (ID 1)

    console.log(`Found ${visibleCourses.length} visible courses to sync`);

    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < visibleCourses.length; i++) {
      const course = visibleCourses[i];
      console.log(
        `\n[${i + 1}/${visibleCourses.length}] Syncing: ${
          course.fullname
        } (ID: ${course.id})`
      );

      try {
        // Call the single course sync internally
        // const response = await axios.post(
        //   `http://localhost:${PORT || 3000}/api/moodle/sync/course/${course.id}`
        // );
        const response = await axios.post(
          `${API_URL}/api/moodle/sync/course/${course.id}`
        );

        results.push({
          courseId: course.id,
          courseName: course.fullname,
          success: true,
          data: response.data,
        });
        successCount++;
      } catch (error) {
        console.error(
          `   ✗ Failed to sync course ${course.id}: ${error.message}`
        );
        results.push({
          courseId: course.id,
          courseName: course.fullname,
          success: false,
          error: error.message,
        });
        failCount++;
      }
    }

    console.log("\n" + "=".repeat(80));
    console.log("ALL COURSES SYNC COMPLETED");
    console.log("=".repeat(80));
    console.log(`Success: ${successCount}/${visibleCourses.length}`);
    console.log(`Failed: ${failCount}/${visibleCourses.length}`);
    console.log("=".repeat(80) + "\n");

    res.json({
      success: true,
      message: `Synced ${successCount}/${visibleCourses.length} courses`,
      summary: {
        total: visibleCourses.length,
        success: successCount,
        failed: failCount,
      },
      results: results,
    });
  } catch (error) {
    console.error("Error syncing all courses:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================================
// ENDPOINT: TEST MOODLE CONNECTION
// ============================================================================

app.get("/api/moodle/test-connection", async (req, res) => {
  try {
    const moodle = new MoodleAPIClient(
      process.env.MOODLE_URL,
      process.env.MOODLE_TOKEN
    );

    console.log("Testing Moodle connection...");
    const courses = await moodle.getCourses();
    console.log(`Connection successful! Found ${courses.length} courses`);

    res.json({
      success: true,
      message: "Moodle connection successful",
      moodleUrl: process.env.MOODLE_URL,
      coursesFound: courses.length,
      sampleCourses: courses.slice(0, 5).map((c) => ({
        id: c.id,
        name: c.fullname,
        visible: c.visible === 1,
      })),
    });
  } catch (error) {
    console.error(" Connection test failed:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message:
        "Failed to connect to Moodle. Please check your MOODLE_URL and MOODLE_TOKEN.",
    });
  }
});

// ============================================================================
// ENDPOINT: GET SYNC STATUS
// ============================================================================

app.get("/api/moodle/sync/status/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;

    // Get course info
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("*")
      .eq("course_id", parseInt(courseId))
      .single();

    if (courseError) throw courseError;

    // Get counts
    const { count: enrollmentCount } = await supabase
      .from("enrollments")
      .select("*", { count: "exact", head: true })
      .eq("course_id", parseInt(courseId));

    const { count: activityCount } = await supabase
      .from("activities")
      .select("*", { count: "exact", head: true })
      .eq("course_id", parseInt(courseId));

    const { count: completionCount } = await supabase
      .from("activity_completions")
      .select("*", { count: "exact", head: true })
      .eq("course_id", parseInt(courseId));

    res.json({
      success: true,
      course: course,
      stats: {
        enrollments: enrollmentCount || 0,
        activities: activityCount || 0,
        completions: completionCount || 0,
        lastUpdated: course.updated_at,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

cron.schedule(
  "0 22 * * *",
  async () => {
    console.log("\n==================== CRON START ====================");
    console.log("System TZ:", Intl.DateTimeFormat().resolvedOptions().timeZone);
    console.log("Now:", new Date().toISOString());
    console.log(
      "Running full Moodle sync @",
      new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    );

    try {
      const response = await axios.post(
        `${API_URL}/api/moodle/sync/all-courses`
      );
      console.log("All Courses Synced Successfully!", response.data.summary);
    } catch (err) {
      console.error("Sync Failed:", err.message);
    }

    console.log("==================== CRON END ======================\n");
  },
  {
    scheduled: true,
    timezone: "Asia/Kolkata",
  }
);

// Log once at startup
console.log("CRON ACTIVE → Auto sync ALL courses every night @ 10 PM IST");

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log("=".repeat(80));
  console.log("MOODLE COURSE ENROLLMENT & COMPLETION API");
  console.log("=".repeat(80));
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL}`);
  console.log("\n KEY FEATURES:");
  console.log("  ✓ Per course: How many students enrolled");
  console.log("  ✓ Per course: Which classes/activities completed");
  console.log("  ✓ Student progress tracking");
  console.log("  ✓ Completion statistics");
  console.log("\n API ENDPOINTS:");
  console.log("─".repeat(80));
  console.log("COURSES:");
  console.log(
    `  GET  /api/courses                              - All courses with enrollment`
  );
  console.log(
    `  GET  /api/courses/:courseId                    - Course details + stats`
  );
  console.log(
    `  GET  /api/courses/:courseId/students           - Students in course`
  );
  console.log(
    `  GET  /api/courses/:courseId/activities         - Activities/classes in course`
  );
  console.log(
    `  GET  /api/courses/:courseId/stats              - Course completion stats`
  );
  console.log("\nSTUDENTS:");
  console.log(
    `  GET  /api/courses/:courseId/students/:studentId/progress - Student progress`
  );
  console.log(
    `  GET  /api/students/filter                      - Filter students by completion`
  );
  console.log("\nFILTERS:");
  console.log(
    `  GET  /api/filters/courses                      - Course list for dropdown`
  );
  console.log(
    `  GET  /api/filters/activity-types               - Activity types`
  );
  console.log(
    `  GET  /api/filters/sections                     - Sections in course`
  );
  console.log("\nEXPORT:");
  console.log(`  GET  /api/export/course/:courseId?format=students|activities`);
  console.log("=".repeat(80));
});

module.exports = app;
