import * as _ from "lodash";
import * as moment from "moment";
import { Moment } from "moment";
import { Injectable } from "@angular/core";
import { ActivityService } from "../../../shared/services/activity/activity.service";
import { DayStressModel } from "../models/day-stress.model";
import { DayFitnessTrendModel } from "../models/day-fitness-trend.model";
import { SyncedActivityModel } from "../../../../../../common/scripts/models/Sync";
import { FitnessPreparedActivityModel } from "../models/fitness-prepared-activity.model";
import { Gender } from "../../../shared/enums/gender.enum";
import { HeartRateImpulseMode } from "../enums/heart-rate-impulse-mode.enum";
import { FitnessUserSettingsModel } from "../models/fitness-user-settings.model";
import { AppError } from "../../../shared/models/app-error.model";

@Injectable()
export class FitnessService {

	public static readonly FUTURE_DAYS_PREVIEW: number = 14;
	public static readonly DEFAULT_LTHR_KARVONEN_HRR_FACTOR: number = 0.85;

	constructor(public activityService: ActivityService) {
	}

	/**
	 * Prepare activities by assigning stress scores on each of them
	 * @param {FitnessUserSettingsModel} fitnessUserSettingsModel
	 * @param {HeartRateImpulseMode} heartRateImpulseMode
	 * @param {boolean} powerMeterEnable
	 * @param {boolean} swimEnable
	 * @param {string[]} skipActivityTypes
	 * @returns {Promise<FitnessPreparedActivityModel[]>}
	 */
	public prepare(fitnessUserSettingsModel: FitnessUserSettingsModel,
				   heartRateImpulseMode: HeartRateImpulseMode,
				   powerMeterEnable: boolean,
				   swimEnable: boolean,
				   skipActivityTypes?: string[]): Promise<FitnessPreparedActivityModel[]> {


		if (heartRateImpulseMode === HeartRateImpulseMode.TRIMP) {

			if (powerMeterEnable) {
				const reason = "'Power Stress Score' calculation method cannot work with " +
					"'TRIMP (Training Impulse)' calculation method.";
				return Promise.reject(new AppError(AppError.FT_PSS_USED_WITH_TRIMP_CALC_METHOD, reason));
			}

			if (swimEnable) {
				const reason = "'Swim Stress Score' calculation method cannot work with 'TRIMP (Training Impulse)' calculation method.";
				return Promise.reject(new AppError(AppError.FT_SSS_USED_WITH_TRIMP_CALC_METHOD, reason));
			}
		}

		return new Promise((resolve: (result: FitnessPreparedActivityModel[]) => void,
							reject: (error: AppError) => void) => {

			return this.activityService.fetch().then((activities: SyncedActivityModel[]) => {

				const fitnessPreparedActivities: FitnessPreparedActivityModel[] = [];
				let hasMinimumFitnessRequiredData = false;

				_.forEach(activities, (activity: SyncedActivityModel) => {

					if (!_.isEmpty(skipActivityTypes) && _.indexOf(skipActivityTypes, activity.type) !== -1) {
						return;
					}

					// Check if activity is eligible to fitness computing
					const hasHeartRateData: boolean = (activity.extendedStats
						&& !_.isEmpty(activity.extendedStats.heartRateData)
						&& _.isNumber(activity.extendedStats.heartRateData.TRIMP));

					const isPowerMeterUsePossible: boolean = (activity.type === "Ride" || activity.type === "VirtualRide" || activity.type === "EBikeRide")
						&& powerMeterEnable
						&& _.isNumber(fitnessUserSettingsModel.cyclingFtp)
						&& activity.extendedStats && activity.extendedStats.powerData
						&& activity.extendedStats.powerData.hasPowerMeter
						&& _.isNumber(activity.extendedStats.powerData.weightedPower);

					const hasSwimmingData: boolean = (swimEnable && _.isNumber(fitnessUserSettingsModel.swimFtp) && fitnessUserSettingsModel.swimFtp > 0
						&& activity.type === "Swim"
						&& _.isNumber(activity.distance_raw) && _.isNumber(activity.moving_time_raw)
						&& activity.moving_time_raw > 0);

					const momentStartTime: Moment = moment(activity.start_time);

					const fitnessReadyActivity: FitnessPreparedActivityModel = {
						id: activity.id,
						date: momentStartTime.toDate(),
						timestamp: momentStartTime.toDate().getTime(),
						dayOfYear: momentStartTime.dayOfYear(),
						year: momentStartTime.year(),
						type: activity.type,
						activityName: activity.name,

					};

					if (hasHeartRateData) {

						if (heartRateImpulseMode === HeartRateImpulseMode.TRIMP) {

							fitnessReadyActivity.trainingImpulseScore = activity.extendedStats.heartRateData.TRIMP;

						} else if (heartRateImpulseMode === HeartRateImpulseMode.HRSS) {

							const userLthrAlongActivityType: number = this.resolveLTHR(activity.type, fitnessUserSettingsModel);

							fitnessReadyActivity.heartRateStressScore = this.computeHeartRateStressScore(fitnessUserSettingsModel.userGender,
								fitnessUserSettingsModel.userMaxHr,
								fitnessUserSettingsModel.userRestHr,
								userLthrAlongActivityType,
								activity.extendedStats.heartRateData.TRIMP);
						}

						hasMinimumFitnessRequiredData = true;
					}

					if (isPowerMeterUsePossible) {
						const movingTime = activity.moving_time_raw;
						const weightedPower = activity.extendedStats.powerData.weightedPower;
						fitnessReadyActivity.powerStressScore = this.computePowerStressScore(movingTime, weightedPower, fitnessUserSettingsModel.cyclingFtp);
						hasMinimumFitnessRequiredData = true;
					}

					if (hasSwimmingData) {
						fitnessReadyActivity.swimStressScore = this.computeSwimStressScore(activity.distance_raw,
							activity.moving_time_raw,
							activity.elapsed_time_raw,
							fitnessUserSettingsModel.swimFtp);
						hasMinimumFitnessRequiredData = true;
					}

					fitnessPreparedActivities.push(fitnessReadyActivity);
				});

				if (!hasMinimumFitnessRequiredData) {
					reject(new AppError(AppError.FT_NO_MINIMUM_REQUIRED_ACTIVITIES,
						"No activities has minimum required data to generate a fitness trend"));
				}

				resolve(fitnessPreparedActivities);
			});
		});
	}

	/**
	 * Return day by day the athlete stress. Active & rest days included
	 * @param {FitnessUserSettingsModel} fitnessUserSettingsModel
	 * @param {HeartRateImpulseMode} heartRateImpulseMode
	 * @param {boolean} powerMeterEnable
	 * @param {boolean} swimEnable
	 * @param {string[]} skipActivityTypes
	 * @returns {Promise<DayStressModel[]>}
	 */
	public generateDailyStress(fitnessUserSettingsModel: FitnessUserSettingsModel,
							   heartRateImpulseMode: HeartRateImpulseMode,
							   powerMeterEnable: boolean,
							   swimEnable: boolean,
							   skipActivityTypes?: string[]): Promise<DayStressModel[]> {

		return new Promise((resolve: (activityDays: DayStressModel[]) => void,
							reject: (error: string) => void) => {

			this.prepare(fitnessUserSettingsModel, heartRateImpulseMode, powerMeterEnable, swimEnable, skipActivityTypes)
				.then((fitnessPreparedActivities: FitnessPreparedActivityModel[]) => {

					// Subtract 1 day to the first activity done in history:
					// Goal is to show graph point with 1 day before
					const startDay = moment(_.first(fitnessPreparedActivities).date)
						.subtract(1, "days").startOf("day");

					const today: Moment = this.getTodayMoment().startOf("day"); // Today end of day

					// Now inject days off/resting
					const dailyActivity: DayStressModel[] = [];
					const currentDay = moment(startDay).clone();

					while (currentDay.isSameOrBefore(today)) {

						// Compute athlete stress on that current day.
						const dayStress: DayStressModel = this.dayStressOnDate(currentDay, fitnessPreparedActivities);

						// Then push every day... Rest or active...
						dailyActivity.push(dayStress);

						// If current day is today. The last real day right?! Then leave the loop !
						if (currentDay.isSame(today)) {
							break;
						}

						// Add a day until today is reached :)
						currentDay.add(1, "days");
					}

					// Then add PREVIEW days
					this.appendPreviewDaysToDailyActivity(currentDay, dailyActivity);

					resolve(dailyActivity);

				}, error => reject(error));
		});
	}

	/**
	 *
	 * @param {number} movingTime
	 * @param {number} weightedPower
	 * @param {number} cyclingFtp
	 * @returns {number}
	 */
	public computePowerStressScore(movingTime: number, weightedPower: number, cyclingFtp: number): number {
		return (movingTime * weightedPower * (weightedPower / cyclingFtp) / (cyclingFtp * 3600) * 100);
	}

	/**
	 *
	 * @param {number} distance
	 * @param {number} movingTime
	 * @param {number} elaspedTime
	 * @param {number} swimFtp
	 * @returns {number}
	 */
	public computeSwimStressScore(distance: number, movingTime: number, elaspedTime: number, swimFtp: number) {
		const normalizedSwimSpeed = distance / (movingTime / 60); // Normalized_Swim_Speed (m/min) = distance(m) / timeInMinutesNoRest
		const swimIntensity = normalizedSwimSpeed / swimFtp; // Intensity = Normalized_Swim_Speed / Swim FTP
		return Math.pow(swimIntensity, 3) * (elaspedTime / 3600) * 100; // Swim Stress Score = Intensity^3 * TotalTimeInHours * 100
	}

	/**
	 *
	 * @param {string} activityType
	 * @param {FitnessUserSettingsModel} fitnessUserSettingsModel
	 * @returns {number}
	 */
	public resolveLTHR(activityType: string, fitnessUserSettingsModel: FitnessUserSettingsModel): number {

		if (fitnessUserSettingsModel.userLactateThreshold) {
			if (activityType === "Ride" || activityType === "VirtualRide" || activityType === "EBikeRide") {
				if (_.isNumber(fitnessUserSettingsModel.userLactateThreshold.cycling)) {
					return fitnessUserSettingsModel.userLactateThreshold.cycling;
				}
			}

			if (activityType === "Run") {
				if (_.isNumber(fitnessUserSettingsModel.userLactateThreshold.running)) {
					return fitnessUserSettingsModel.userLactateThreshold.running;
				}
			}

			if (_.isNumber(fitnessUserSettingsModel.userLactateThreshold.default)) {
				return fitnessUserSettingsModel.userLactateThreshold.default;
			}
		}

		return fitnessUserSettingsModel.userRestHr + FitnessService.DEFAULT_LTHR_KARVONEN_HRR_FACTOR
			* (fitnessUserSettingsModel.userMaxHr - fitnessUserSettingsModel.userRestHr);
	}

	/**
	 * Compute Heart Rate Stress Score (HRSS)
	 * @param {Gender} userGender
	 * @param {number} userMaxHr
	 * @param {number} userMinHr
	 * @param {number} lactateThreshold
	 * @param {number} activityTrainingImpulse
	 * @returns {number}
	 */
	public computeHeartRateStressScore(userGender: Gender, userMaxHr: number, userMinHr: number, lactateThreshold: number, activityTrainingImpulse: number): number {
		const lactateThresholdReserve = (lactateThreshold - userMinHr) / (userMaxHr - userMinHr);
		const TRIMPGenderFactor: number = (userGender === Gender.MEN) ? 1.92 : 1.67;
		const lactateThresholdTrainingImpulse = 60 * lactateThresholdReserve * 0.64 * Math.exp(TRIMPGenderFactor * lactateThresholdReserve);
		return (activityTrainingImpulse / lactateThresholdTrainingImpulse * 100);
	}

	/**
	 * ComputeTrend the fitness trend
	 * @param {FitnessUserSettingsModel} fitnessUserSettingsModel
	 * @param {HeartRateImpulseMode} heartRateImpulseMode
	 * @param {boolean} isPowerMeterEnabled
	 * @param {boolean} isSwimEnabled
	 * @param {string[]} skipActivityTypes
	 * @returns {Promise<DayFitnessTrendModel[]>}
	 */
	public computeTrend(fitnessUserSettingsModel: FitnessUserSettingsModel,
						heartRateImpulseMode: HeartRateImpulseMode,
						isPowerMeterEnabled: boolean,
						isSwimEnabled: boolean,
						skipActivityTypes?: string[]): Promise<DayFitnessTrendModel[]> {

		return new Promise((resolve: (fitnessTrend: DayFitnessTrendModel[]) => void,
							reject: (error: string) => void) => {

			this.generateDailyStress(fitnessUserSettingsModel, heartRateImpulseMode, isPowerMeterEnabled, isSwimEnabled, skipActivityTypes)
				.then((dailyActivity: DayStressModel[]) => {

					let ctl = 0;
					let atl = 0;
					let tsb = 0;

					const fitnessTrend: DayFitnessTrendModel[] = [];

					_.forEach(dailyActivity, (dayStress: DayStressModel) => {

						ctl = ctl + (dayStress.finalStressScore - ctl) * (1 - Math.exp(-1 / 42));
						atl = atl + (dayStress.finalStressScore - atl) * (1 - Math.exp(-1 / 7));
						tsb = ctl - atl;

						const dayFitnessTrend: DayFitnessTrendModel = new DayFitnessTrendModel(dayStress, ctl, atl, tsb);

						if (_.isNumber(dayStress.heartRateStressScore) && dayStress.heartRateStressScore > 0) {
							dayFitnessTrend.heartRateStressScore = dayStress.heartRateStressScore;
						}

						if (_.isNumber(dayStress.trainingImpulseScore) && dayStress.trainingImpulseScore > 0) {
							dayFitnessTrend.trainingImpulseScore = dayStress.trainingImpulseScore;
						}

						if (_.isNumber(dayStress.powerStressScore) && dayStress.powerStressScore > 0) {
							dayFitnessTrend.powerStressScore = dayStress.powerStressScore;
						}

						if (_.isNumber(dayStress.swimStressScore) && dayStress.swimStressScore > 0) {
							dayFitnessTrend.swimStressScore = dayStress.swimStressScore;
						}

						if (_.isNumber(dayStress.finalStressScore) && dayStress.finalStressScore > 0) {
							dayFitnessTrend.finalStressScore = dayStress.finalStressScore;
						}

						fitnessTrend.push(dayFitnessTrend);

					});

					resolve(fitnessTrend);

				}, error => {

					reject(error); // e.g. No activities found

				});
		});
	}

	/**
	 *
	 * @param {moment.Moment} startFrom
	 * @param {DayStressModel[]} dailyActivity
	 */
	public appendPreviewDaysToDailyActivity(startFrom: moment.Moment, dailyActivity: DayStressModel[]) {

		for (let i = 0; i < FitnessService.FUTURE_DAYS_PREVIEW; i++) {

			const futureDate: Date = startFrom.add(1, "days").startOf("day").toDate();

			const dayActivity: DayStressModel = new DayStressModel(futureDate, true);

			dailyActivity.push(dayActivity);
		}
	}

	/**
	 *
	 * @param {moment.Moment} currentDay
	 * @param {FitnessPreparedActivityModel[]} fitnessPreparedActivities
	 * @returns {DayStressModel}
	 */

	public dayStressOnDate(currentDay: moment.Moment, fitnessPreparedActivities: FitnessPreparedActivityModel[]): DayStressModel {

		const foundActivitiesThatDay: FitnessPreparedActivityModel[] = _.filter(fitnessPreparedActivities, {
			year: currentDay.year(),
			dayOfYear: currentDay.dayOfYear(),
		});

		const dayActivity: DayStressModel = new DayStressModel(currentDay.toDate(), false);

		// Compute final stress scores on that day
		if (foundActivitiesThatDay.length > 0) {

			_.forEach(foundActivitiesThatDay, (activity: FitnessPreparedActivityModel) => {

				dayActivity.ids.push(activity.id);
				dayActivity.activitiesName.push(activity.activityName);
				dayActivity.types.push(activity.type);

				// Apply scores for that day
				// PSS
				if (_.isNumber(activity.powerStressScore)) {

					if (!dayActivity.powerStressScore) { // Initialize value if not exists
						dayActivity.powerStressScore = 0;
					}

					dayActivity.powerStressScore += activity.powerStressScore;
				}

				// HRSS
				if (_.isNumber(activity.heartRateStressScore)) { // Check for HRSS score if available
					if (!dayActivity.heartRateStressScore) { // Initialize value if not exists
						dayActivity.heartRateStressScore = 0;
					}
					dayActivity.heartRateStressScore += activity.heartRateStressScore;
				}

				// TRIMP
				if (_.isNumber(activity.trainingImpulseScore)) { // Check for TRIMP score if available
					if (!dayActivity.trainingImpulseScore) { // Initialize value if not exists
						dayActivity.trainingImpulseScore = 0;
					}
					dayActivity.trainingImpulseScore += activity.trainingImpulseScore;
				}

				// SwimSS
				if (_.isNumber(activity.swimStressScore)) { // Check for TRIMP score if available
					if (!dayActivity.swimStressScore) { // Initialize value if not exists
						dayActivity.swimStressScore = 0;
					}
					dayActivity.swimStressScore += activity.swimStressScore;
				}

				// Apply final stress score for that day
				if (activity.powerStressScore) { // Use PSS has priority over TRIMP/HRSS

					dayActivity.finalStressScore += activity.powerStressScore;

				} else if (activity.heartRateStressScore) {

					dayActivity.finalStressScore += activity.heartRateStressScore;

				} else if (activity.trainingImpulseScore) {

					dayActivity.finalStressScore += activity.trainingImpulseScore;

				} else if (activity.swimStressScore) {

					dayActivity.finalStressScore += activity.swimStressScore;

				}
			});

		}

		return dayActivity;
	}

	public getTodayMoment(): Moment {
		return moment();
	}


}
