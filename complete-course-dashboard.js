/**
 * COMPLETE COURSE DASHBOARD - ALL DATA
 * Saves data directly to Supabase without file exports
 */

// Load environment variables
require('dotenv').config();

const MoodleActivityTracker = require("./moodle-tracker");
const { createClient } = require('@supabase/supabase-js');

class CompleteCourseData {
  constructor(moodleUrl, token) {
    console.log('\n🔧 Environment Variables Status:');
    console.log('   SUPABASE_URL:', process.env.SUPABASE_URL ? '✓ Loaded' : '✗ Missing');
    console.log('   SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? '✓ Loaded' : '✗ Missing');
    
    this.tracker = new MoodleActivityTracker(moodleUrl, token);
    this.initializeSupabase();
  }

  initializeSupabase() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    
    console.log('\n🔧 Initializing Supabase Client...');
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase URL and Service Key must be provided in environment variables');
    }

    try {
      this.supabase = createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: false
        }
      });
      console.log('✅ Supabase client initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Supabase client:', error.message);
      throw error;
    }
  }

  async testSupabaseConnection() {
    console.log('\n🔌 Testing Supabase connection...');
    
    try {
      const { data, error } = await this.supabase
        .from('students')
        .select('*')
        .limit(1);

      if (error && error.code === '42P01') {
        console.log('⚠️  Tables might not exist yet. This is normal for first run.');
      } else if (error) {
        throw error;
      }

      console.log('✅ Supabase connection test passed');
      return true;
    } catch (error) {
      console.error('❌ Supabase connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Get detailed course information
   */
  async getCourseInformation(courseId) {
    try {
      const courses = await this.tracker.callApi("core_course_get_courses", {
        options: { ids: [courseId] },
      });

      if (courses && courses.length > 0) {
        const course = courses[0];
        return {
          id: course.id,
          fullname: course.fullname,
          shortname: course.shortname,
          categoryid: course.categoryid,
          summary: course.summary || "",
          summaryformat: course.summaryformat,
          format: course.format,
          startdate: this.formatTimestamp(course.startdate),
          enddate: this.formatTimestamp(course.enddate),
          visible: course.visible === 1,
          showgrades: course.showgrades === 1,
          lang: course.lang || "en",
          enablecompletion: course.enablecompletion === 1,
          completionnotify: course.completionnotify === 1,
          courseformatoptions: course.courseformatoptions || [],
        };
      }

      // Fallback
      return {
        id: courseId,
        fullname: `Course ${courseId}`,
        shortname: `course${courseId}`,
        visible: true,
        enablecompletion: true,
      };
    } catch (error) {
      console.log(`⚠️  Could not get full course info: ${error.message}`);
      return {
        id: courseId,
        fullname: `Course ${courseId}`,
        shortname: `course${courseId}`,
      };
    }
  }

  /**
   * Get detailed enrolled students information
   */
  async getEnrolledStudentsDetails(courseId) {
    const users = await this.tracker.getEnrolledUsers(courseId);

    return users.map((user) => ({
      id: user.id,
      username: user.username,
      firstname: user.firstname,
      lastname: user.lastname,
      fullname: `${user.firstname} ${user.lastname}`,
      email: user.email || "",
      firstaccess: this.formatTimestamp(user.firstaccess),
      lastaccess: this.formatTimestamp(user.lastaccess),
      lastcourseaccess: this.formatTimestamp(user.lastcourseaccess),
      roles: user.roles
        ? user.roles.map((r) => r.shortname).join(", ")
        : "student",
      enrolledcourses: user.enrolledcourses ? user.enrolledcourses.length : 0,
    }));
  }

  /**
   * Get detailed course content with publishing status
   */
  async getCourseContentDetails(courseId) {
    const contents = await this.tracker.getCourseContents(courseId);

    return contents.map((section) => ({
      sectionId: section.id,
      sectionNumber: section.section,
      sectionName: section.name,
      summary: section.summary || "",
      visible: section.visible === 1,
      activities: (section.modules || []).map((module) => ({
        activityId: module.id,
        activityName: module.name,
        activityType: module.modname,
        modplural: module.modplural,
        indent: module.indent,
        url: module.url || "",
        visible: module.visible === 1,
        visibleoncoursepage: module.visibleoncoursepage === 1,
        uservisible: module.uservisible !== false,
        availabilityinfo: module.availabilityinfo || "",
        published: module.visible === 1 && module.visibleoncoursepage === 1,
        hasCompletion: (module.completion || 0) > 0,
        completionExpected: module.completionexpected || 0,
        completionExpectedDate: this.formatTimestamp(module.completionexpected),
        addedDate: this.formatTimestamp(module.added),
        description: module.description || "",
        contents: module.contents || [],
        contentsinfo: module.contentsinfo || {},
      })),
    }));
  }

  /**
   * Get completion data for all students for all activities
   */
  async getAllStudentCompletions(courseId, students, sections) {
    const completions = [];
    const totalStudents = students.length;

    for (let i = 0; i < students.length; i++) {
      const student = students[i];

      process.stdout.write(
        `  Processing ${i + 1}/${totalStudents}: ${student.fullname}\r`
      );

      try {
        const studentCompletions = await this.tracker.getActivitiesCompletion(
          courseId,
          student.id
        );

        // Create a map of completions by activity ID
        const completionMap = {};
        for (const comp of studentCompletions.statuses || []) {
          completionMap[comp.cmid] = comp;
        }

        // Match completions with activities
        for (const section of sections) {
          for (const activity of section.activities) {
            const completion = completionMap[activity.activityId] || {};

            completions.push({
              studentId: student.id,
              studentName: student.fullname,
              studentEmail: student.email,
              sectionNumber: section.sectionNumber,
              sectionName: section.sectionName,
              activityId: activity.activityId,
              activityName: activity.activityName,
              activityType: activity.activityType,
              published: activity.published,
              visible: activity.visible,
              hasCompletionTracking: activity.hasCompletion,
              completionState: completion.state || 0,
              completionStatus: this.getCompletionStatus(completion.state),
              isCompleted: (completion.state || 0) >= 1,
              isPassed: (completion.state || 0) === 2,
              isFailed: (completion.state || 0) === 3,
              completionDate: this.formatTimestamp(completion.timecompleted),
              trackingType: this.getTrackingType(completion.tracking),
              overriddenBy: completion.overrideby,
            });
          }
        }
      } catch (error) {
        console.log(
          `\n⚠️  Warning: Could not get completions for ${student.fullname}: ${error.message}`
        );
      }
    }

    console.log(""); // New line after progress
    return completions;
  }

  /**
   * Get ALL course data - Complete dashboard
   */
  async getCompleteCourseData(courseId) {
    console.log("\n" + "=".repeat(80));
    console.log("📊 FETCHING COMPLETE COURSE DATA");
    console.log("=".repeat(80));

    const startTime = Date.now();

    const courseData = {
      courseInfo: null,
      enrolledStudents: [],
      courseContent: [],
      studentCompletions: [],
      courseSummary: {},
      activityStatistics: [],
      studentStatistics: [],
      metadata: {
        fetchedAt: new Date().toISOString(),
        processingTime: 0,
      },
    };

    try {
      console.log("\n📚 Step 1/5: Fetching course information...");
      courseData.courseInfo = await this.getCourseInformation(courseId);
      console.log(`✓ Course: ${courseData.courseInfo.fullname}`);

      console.log("\n👥 Step 2/5: Fetching enrolled students...");
      courseData.enrolledStudents = await this.getEnrolledStudentsDetails(courseId);
      console.log(`✓ Found ${courseData.enrolledStudents.length} enrolled students`);

      console.log("\n📖 Step 3/5: Fetching course content...");
      courseData.courseContent = await this.getCourseContentDetails(courseId);
      const totalActivities = courseData.courseContent.reduce(
        (sum, section) => sum + section.activities.length,
        0
      );
      console.log(`✓ Found ${courseData.courseContent.length} sections with ${totalActivities} activities`);

      console.log("\n✅ Step 4/5: Fetching completion data for all students...");
      courseData.studentCompletions = await this.getAllStudentCompletions(
        courseId,
        courseData.enrolledStudents,
        courseData.courseContent
      );
      console.log(`✓ Processed ${courseData.studentCompletions.length} completion records`);

      console.log("\n📊 Step 5/5: Calculating statistics...");
      courseData.courseSummary = this.calculateCourseSummary(courseData);
      courseData.activityStatistics = this.calculateActivityStatistics(courseData);
      courseData.studentStatistics = this.calculateStudentStatistics(courseData);
      console.log(`✓ Statistics calculated`);

      courseData.metadata.processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log("\n✅ COMPLETE! All course data fetched successfully");
      console.log(`⏱️  Total processing time: ${courseData.metadata.processingTime}s`);

      return courseData;
    } catch (error) {
      console.error(`\n❌ Error fetching course data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Calculate course-level summary statistics
   */
  calculateCourseSummary(courseData) {
    const students = courseData.enrolledStudents;
    const activities = courseData.courseContent.reduce(
      (arr, section) => [...arr, ...section.activities],
      []
    );
    const completions = courseData.studentCompletions;

    const publishedActivities = activities.filter((a) => a.published);
    const trackedActivities = activities.filter((a) => a.hasCompletion);
    const totalCompletions = completions.filter(
      (c) => c.isCompleted && c.hasCompletionTracking
    ).length;
    const totalPossible = students.length * trackedActivities.length;

    return {
      totalStudents: students.length,
      totalSections: courseData.courseContent.length,
      totalActivities: activities.length,
      publishedActivities: publishedActivities.length,
      unpublishedActivities: activities.length - publishedActivities.length,
      activitiesWithTracking: trackedActivities.length,
      activitiesWithoutTracking: activities.length - trackedActivities.length,
      overallCompletionRate:
        totalPossible > 0
          ? ((totalCompletions / totalPossible) * 100).toFixed(2)
          : 0,
      totalCompletions: totalCompletions,
      totalPossibleCompletions: totalPossible,
      activitiesByType: this.groupByType(activities),
      courseDuration: this.calculateCourseDuration(courseData.courseInfo),
      lastActivity: this.getLastActivityDate(completions),
    };
  }

  /**
   * Calculate per-activity statistics
   */
  calculateActivityStatistics(courseData) {
    const activities = courseData.courseContent.reduce(
      (arr, section) => [
        ...arr,
        ...section.activities.map((a) => ({
          ...a,
          sectionName: section.sectionName,
        })),
      ],
      []
    );
    const completions = courseData.studentCompletions;
    const totalStudents = courseData.enrolledStudents.length;

    return activities.map((activity) => {
      const activityCompletions = completions.filter(
        (c) => c.activityId === activity.activityId && c.hasCompletionTracking
      );

      const completed = activityCompletions.filter((c) => c.isCompleted).length;
      const passed = activityCompletions.filter((c) => c.isPassed).length;
      const failed = activityCompletions.filter((c) => c.isFailed).length;

      return {
        activityId: activity.activityId,
        activityName: activity.activityName,
        activityType: activity.activityType,
        sectionName: activity.sectionName,
        published: activity.published,
        hasTracking: activity.hasCompletion,
        totalStudents: totalStudents,
        studentsCompleted: completed,
        studentsPassed: passed,
        studentsFailed: failed,
        studentsNotStarted: totalStudents - completed,
        completionRate:
          totalStudents > 0
            ? ((completed / totalStudents) * 100).toFixed(2)
            : 0,
        passRate: completed > 0 ? ((passed / completed) * 100).toFixed(2) : 0,
        addedDate: activity.addedDate,
        expectedCompletionDate: activity.completionExpectedDate,
      };
    });
  }

  /**
   * Calculate per-student statistics
   */
  calculateStudentStatistics(courseData) {
    const students = courseData.enrolledStudents;
    const completions = courseData.studentCompletions;
    const trackedActivities = courseData.courseContent.reduce(
      (arr, section) => [
        ...arr,
        ...section.activities.filter((a) => a.hasCompletion),
      ],
      []
    ).length;

    return students.map((student) => {
      const studentCompletions = completions.filter(
        (c) => c.studentId === student.id && c.hasCompletionTracking
      );

      const completed = studentCompletions.filter((c) => c.isCompleted).length;
      const passed = studentCompletions.filter((c) => c.isPassed).length;
      const failed = studentCompletions.filter((c) => c.isFailed).length;

      return {
        studentId: student.id,
        studentName: student.fullname,
        studentEmail: student.email,
        firstAccess: student.firstaccess,
        lastAccess: student.lastaccess,
        lastCourseAccess: student.lastcourseaccess,
        roles: student.roles,
        totalActivities: trackedActivities,
        activitiesCompleted: completed,
        activitiesPassed: passed,
        activitiesFailed: failed,
        activitiesRemaining: trackedActivities - completed,
        completionPercentage:
          trackedActivities > 0
            ? ((completed / trackedActivities) * 100).toFixed(2)
            : 0,
        passPercentage:
          completed > 0 ? ((passed / completed) * 100).toFixed(2) : 0,
        isActive: this.isStudentActive(student),
        performanceLevel: this.getPerformanceLevel(
          completed / trackedActivities
        ),
      };
    });
  }

  /**
   * Save all course data to Supabase
   */
  async saveToSupabase(courseData) {
    console.log("\n💾 Saving data to Supabase...");
    
    try {
      console.log("  Saving students...");
      await this.saveStudentsToSupabase(courseData.enrolledStudents);
      
      console.log("  Saving course content...");
      await this.saveCourseContentToSupabase(courseData.courseContent);
      
      console.log("  Saving student statistics...");
      await this.saveStudentStatisticsToSupabase(courseData.studentStatistics);
      
      console.log("  Saving activity statistics...");
      await this.saveActivityStatisticsToSupabase(courseData.activityStatistics);
      
      console.log("  Saving completions...");
      await this.saveCompletionsToSupabase(courseData.studentCompletions);
      
      console.log("✅ All data saved to Supabase successfully!");
    } catch (error) {
      console.error(`❌ Error saving to Supabase: ${error.message}`);
      throw error;
    }
  }

  /**
   * Save students to Supabase
   */
  async saveStudentsToSupabase(students) {
    const studentsData = students.map(student => ({
      id: parseInt(student.id),
      username: student.username,
      firstname: student.firstname,
      lastname: student.lastname,
      fullname: student.fullname,
      email: student.email,
      firstaccess: student.firstaccess ? new Date(student.firstaccess) : null,
      lastaccess: student.lastaccess ? new Date(student.lastaccess) : null,
      lastcourseaccess: student.lastcourseaccess ? new Date(student.lastcourseaccess) : null,
      roles: student.roles,
      enrolledcourses: student.enrolledcourses
    }));

    const { error } = await this.supabase
      .from('students')
      .upsert(studentsData, { onConflict: 'id' });

    if (error) {
      console.error('❌ Error saving students:', error);
      throw error;
    }
  }

  /**
   * Save course content to Supabase
   */
  async saveCourseContentToSupabase(courseContent) {
    console.log("  Saving course content...");
    
    try {
      const flatContent = [];
      
      courseContent.forEach((section) => {
        section.activities.forEach((activity) => {
          // Use property assignment to ensure lowercase
          const item = {};
          item.sectionnumber = section.sectionNumber;
          item.sectionname = section.sectionName;
          item.sectionvisible = section.visible;
          item.activityid = parseInt(activity.activityId);
          item.activityname = activity.activityName;
          item.activitytype = activity.activityType;
          item.modplural = activity.modplural;
          item.indent = activity.indent;
          item.url = activity.url;
          item.visible = activity.visible;
          item.visibleoncoursepage = activity.visibleoncoursepage;
          item.uservisible = activity.uservisible;
          item.availabilityinfo = activity.availabilityinfo;
          item.published = activity.published;
          item.hascompletion = activity.hasCompletion;
          item.completionexpected = activity.completionExpected;
          item.completionexpecteddate = activity.completionExpectedDate ? new Date(activity.completionExpectedDate) : null;
          item.addeddate = activity.addedDate ? new Date(activity.addedDate) : null;
          item.description = activity.description;
          
          flatContent.push(item);
        });
      });

      console.log(`  Inserting ${flatContent.length} items...`);

      // Use a fresh client to avoid caching issues
      const freshClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      
      const { error } = await freshClient
        .from('course_content')
        .upsert(flatContent, { onConflict: 'activityid' });

      if (error) throw error;
      
      console.log(`✅ Successfully saved course content`);
      
    } catch (error) {
      console.error('❌ Error saving course content:', error.message);
      throw error;
    }
  }

  /**
   * Save student statistics to Supabase
   */
  async saveStudentStatisticsToSupabase(studentStatistics) {
    const statsData = studentStatistics.map(stat => ({
      studentid: parseInt(stat.studentId),
      studentname: stat.studentName,
      studentemail: stat.studentEmail,
      firstaccess: stat.firstAccess ? new Date(stat.firstAccess) : null,
      lastaccess: stat.lastAccess ? new Date(stat.lastAccess) : null,
      lastcourseaccess: stat.lastCourseAccess ? new Date(stat.lastCourseAccess) : null,
      roles: stat.roles,
      totalactivities: stat.totalActivities,
      activitiescompleted: stat.activitiesCompleted,
      activitiespassed: stat.activitiesPassed,
      activitiesfailed: stat.activitiesFailed,
      activitiesremaining: stat.activitiesRemaining,
      completionpercentage: parseFloat(stat.completionPercentage),
      passpercentage: parseFloat(stat.passPercentage),
      isactive: stat.isActive,
      performancelevel: stat.performanceLevel
    }));

    const { error } = await this.supabase
      .from('student_statistics')
      .upsert(statsData, { onConflict: 'studentid' });

    if (error) throw error;
  }

  /**
   * Save activity statistics to Supabase
   */
  async saveActivityStatisticsToSupabase(activityStatistics) {
    const statsData = activityStatistics.map(stat => ({
      activityid: parseInt(stat.activityId),
      activityname: stat.activityName,
      activitytype: stat.activityType,
      sectionname: stat.sectionName,
      published: stat.published,
      hastracking: stat.hasTracking,
      totalstudents: stat.totalStudents,
      studentscompleted: stat.studentsCompleted,
      studentspassed: stat.studentsPassed,
      studentsfailed: stat.studentsFailed,
      studentsnotstarted: stat.studentsNotStarted,
      completionrate: parseFloat(stat.completionRate),
      passrate: parseFloat(stat.passRate),
      addeddate: stat.addedDate ? new Date(stat.addedDate) : null,
      expectedcompletiondate: stat.expectedCompletionDate ? new Date(stat.expectedCompletionDate) : null
    }));

    const { error } = await this.supabase
      .from('activity_statistics')
      .upsert(statsData, { onConflict: 'activityid' });

    if (error) throw error;
  }

  /**
   * Save completions to Supabase
   */
  async saveCompletionsToSupabase(completions) {
    const completionsData = completions.map(comp => ({
      studentid: parseInt(comp.studentId),
      studentname: comp.studentName,
      studentemail: comp.studentEmail,
      sectionnumber: comp.sectionNumber,
      sectionname: comp.sectionName,
      activityid: parseInt(comp.activityId),
      activityname: comp.activityName,
      activitytype: comp.activityType,
      published: comp.published,
      visible: comp.visible,
      hascompletiontracking: comp.hasCompletionTracking,
      completionstate: comp.completionState,
      completionstatus: comp.completionStatus,
      iscompleted: comp.isCompleted,
      ispassed: comp.isPassed,
      isfailed: comp.isFailed,
      completiondate: comp.completionDate ? new Date(comp.completionDate) : null,
      trackingtype: comp.trackingType,
      overriddenby: comp.overriddenBy
    }));

    const batchSize = 100;
    for (let i = 0; i < completionsData.length; i += batchSize) {
      const batch = completionsData.slice(i, i + batchSize);
      
      const { error } = await this.supabase
        .from('completions')
        .upsert(batch, { onConflict: 'studentid,activityid' });

      if (error) throw error;
      
      console.log(`    Batch ${Math.floor(i/batchSize) + 1} completed (${Math.min(i + batchSize, completionsData.length)}/${completionsData.length})`);
    }
  }

  /**
   * Helper functions
   */
  formatTimestamp(timestamp) {
    if (!timestamp || timestamp === 0) return null;
    return new Date(timestamp * 1000)
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);
  }

  getCompletionStatus(state) {
    const statuses = {
      0: "Incomplete",
      1: "Complete",
      2: "Complete (Passed)",
      3: "Complete (Failed)",
    };
    return statuses[state] || "Unknown";
  }

  getTrackingType(tracking) {
    const types = {
      0: "None",
      1: "Manual",
      2: "Automatic",
    };
    return types[tracking] || "Unknown";
  }

  groupByType(activities) {
    const grouped = {};
    activities.forEach((activity) => {
      if (!grouped[activity.activityType]) {
        grouped[activity.activityType] = 0;
      }
      grouped[activity.activityType]++;
    });
    return grouped;
  }

  calculateCourseDuration(courseInfo) {
    if (!courseInfo.startdate || !courseInfo.enddate) return null;

    const start = new Date(courseInfo.startdate);
    const end = new Date(courseInfo.enddate);
    const days = Math.floor((end - start) / (1000 * 60 * 60 * 24));

    return {
      days: days,
      weeks: Math.floor(days / 7),
      months: Math.floor(days / 30),
    };
  }

  getLastActivityDate(completions) {
    const dates = completions
      .map((c) => c.completionDate)
      .filter((d) => d !== null);

    return dates.length > 0 ? dates.sort().reverse()[0] : null;
  }

  isStudentActive(student) {
    if (!student.lastcourseaccess) return false;

    const lastAccess = new Date(student.lastcourseaccess);
    const daysSinceAccess =
      (Date.now() - lastAccess.getTime()) / (1000 * 60 * 60 * 24);

    return daysSinceAccess <= 7;
  }

  getPerformanceLevel(completionRate) {
    if (completionRate >= 0.9) return "Excellent";
    if (completionRate >= 0.7) return "Good";
    if (completionRate >= 0.5) return "Average";
    if (completionRate >= 0.3) return "Below Average";
    return "Poor";
  }

  /**
   * Print comprehensive summary
   */
  printSummary(courseData) {
    console.log("\n" + "=".repeat(80));
    console.log("📊 COURSE DASHBOARD SUMMARY");
    console.log("=".repeat(80));

    console.log("\n📚 Course Information:");
    console.log(`   Name: ${courseData.courseInfo.fullname}`);
    console.log(`   Short Name: ${courseData.courseInfo.shortname}`);
    console.log(`   Visible: ${courseData.courseInfo.visible ? "Yes" : "No"}`);
    console.log(
      `   Completion Enabled: ${
        courseData.courseInfo.enablecompletion ? "Yes" : "No"
      }`
    );
    if (courseData.courseInfo.startdate) {
      console.log(`   Start Date: ${courseData.courseInfo.startdate}`);
    }
    if (courseData.courseInfo.enddate) {
      console.log(`   End Date: ${courseData.courseInfo.enddate}`);
    }

    const summary = courseData.courseSummary;
    console.log("\n📊 Course Statistics:");
    console.log(`   Total Students: ${summary.totalStudents}`);
    console.log(`   Total Sections: ${summary.totalSections}`);
    console.log(`   Total Activities: ${summary.totalActivities}`);
    console.log(`   Published Activities: ${summary.publishedActivities}`);
    console.log(`   Unpublished Activities: ${summary.unpublishedActivities}`);
    console.log(
      `   Activities with Completion Tracking: ${summary.activitiesWithTracking}`
    );
    console.log(
      `   Overall Completion Rate: ${summary.overallCompletionRate}%`
    );

    console.log("\n📝 Activities by Type:");
    Object.entries(summary.activitiesByType).forEach(([type, count]) => {
      console.log(`   ${type}: ${count}`);
    });

    const topStudents = courseData.studentStatistics
      .sort((a, b) => b.completionPercentage - a.completionPercentage)
      .slice(0, 5);

    console.log("\n🏆 Top 5 Students:");
    topStudents.forEach((student, index) => {
      console.log(
        `   ${index + 1}. ${student.studentName}: ${
          student.completionPercentage
        }% (${student.activitiesCompleted}/${student.totalActivities})`
      );
    });

    const lowCompletionActivities = courseData.activityStatistics
      .filter((a) => a.hasTracking && parseFloat(a.completionRate) < 50)
      .sort((a, b) => a.completionRate - b.completionRate)
      .slice(0, 5);

    if (lowCompletionActivities.length > 0) {
      console.log("\n⚠️  Activities with Low Completion (<50%):");
      lowCompletionActivities.forEach((activity, index) => {
        console.log(
          `   ${index + 1}. ${activity.activityName}: ${
            activity.completionRate
          }% (${activity.studentsCompleted}/${activity.totalStudents})`
        );
      });
    }

    console.log("\n" + "=".repeat(80));
  }
}

async function main() {
  console.log("=".repeat(80));
  console.log("📚 COMPLETE COURSE DATA EXTRACTOR");
  console.log("=".repeat(80));

  require('dotenv').config();

  const MOODLE_URL = process.env.MOODLE_URL || "http://omkaravidya.online/webservice/rest/server.php";
  const TOKEN = process.env.MOODLE_TOKEN || "38fff46a850ec4d191e01a2916bad4b3";
  const COURSE_ID = parseInt(process.env.DEFAULT_COURSE_ID) || 5;

  console.log(`\n⚙️  Configuration:`);
  console.log(`   Course ID: ${COURSE_ID}`);
  console.log(`   Moodle URL: ${MOODLE_URL}`);
  console.log(`   Token: ${TOKEN ? '✓ Provided' : '✗ Missing'}`);

  try {
    const courseDashboard = new CompleteCourseData(MOODLE_URL, TOKEN);
    
    const connectionOk = await courseDashboard.testSupabaseConnection();
    if (!connectionOk) return;

    const courseData = await courseDashboard.getCompleteCourseData(COURSE_ID);
    courseDashboard.printSummary(courseData);
    await courseDashboard.saveToSupabase(courseData);
    
    console.log("\n✅ ALL COURSE DATA EXTRACTED AND SAVED TO SUPABASE SUCCESSFULLY!");
    
  } catch (error) {
    console.error("\n❌ Fatal Error:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = CompleteCourseData;