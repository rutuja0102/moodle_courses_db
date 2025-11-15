// moodle-tracker.js
const axios = require('axios');

class MoodleActivityTracker {
    constructor(moodleUrl, token) {
        this.moodleUrl = moodleUrl.replace(/\/$/, ''); // Remove trailing slash
        this.token = token;
        this.baseUrl = `${this.moodleUrl}/webservice/rest/server.php`;
    }

    async callApi(functionName, params = {}) {
        try {
            const requestParams = {
                wstoken: this.token,
                wsfunction: functionName,
                moodlewsrestformat: 'json',
                ...params
            };

            const response = await axios.post(this.baseUrl, requestParams, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            if (response.data && response.data.exception) {
                throw new Error(`Moodle API Error: ${response.data.message}`);
            }

            return response.data;

        } catch (error) {
            console.error(`API Call Failed (${functionName}):`, error.message);
            throw error;
        }
    }

    async getEnrolledUsers(courseId) {
        return await this.callApi('core_enrol_get_enrolled_users', {
            courseid: courseId
        });
    }

    async getCourseContents(courseId) {
        return await this.callApi('core_course_get_contents', {
            courseid: courseId,
            options: [
                {
                    name: 'excludecontents',
                    value: false
                }
            ]
        });
    }

    async getActivitiesCompletion(courseId, userId) {
        return await this.callApi('core_completion_get_activities_completion_status', {
            courseid: courseId,
            userid: userId
        });
    }
}

module.exports = MoodleActivityTracker;