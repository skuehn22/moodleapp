// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { InAppBrowserObject, InAppBrowserOptions } from '@ionic-native/in-app-browser';
import { Md5 } from 'ts-md5/dist/md5';

import { CoreApp } from '@services/app';
import { CoreNetwork } from '@services/network';
import { CoreDB } from '@services/db';
import { CoreEvents } from '@singletons/events';
import { CoreFile } from '@services/file';
import {
    CoreWS,
    CoreWSPreSets,
    CoreWSFileUploadOptions,
    CoreWSAjaxPreSets,
    CoreWSExternalWarning,
    CoreWSUploadFileResult,
    CoreWSPreSetsSplitRequest,
} from '@services/ws';
import { CoreDomUtils, ToastDuration } from '@services/utils/dom';
import { CoreTextUtils } from '@services/utils/text';
import { CoreTimeUtils } from '@services/utils/time';
import { CoreUrlUtils, CoreUrlParams } from '@services/utils/url';
import { CoreUtils, CoreUtilsOpenInBrowserOptions } from '@services/utils/utils';
import { CoreConstants } from '@/core/constants';
import { SQLiteDB } from '@classes/sqlitedb';
import { CoreError } from '@classes/errors/error';
import { CoreWSError } from '@classes/errors/wserror';
import { CoreLogger } from '@singletons/logger';
import { Translate } from '@singletons';
import { CoreIonLoadingElement } from './ion-loading';
import { CoreLang } from '@services/lang';
import { CoreSites, CoreSitesReadingStrategy } from '@services/sites';
import { asyncInstance, AsyncInstance } from '../utils/async-instance';
import { CoreDatabaseTable } from './database/database-table';
import { CoreDatabaseCachingStrategy } from './database/database-table-proxy';
import { CoreSilentError } from './errors/silenterror';
import { CorePromisedValue } from '@classes/promised-value';
import {
    CONFIG_TABLE,
    CoreSiteConfigDBRecord,
    CoreSiteLastViewedDBRecord,
    CoreSiteWSCacheRecord,
    LAST_VIEWED_TABLE,
    WSGroups,
    WS_CACHE_TABLES_PREFIX,
} from '@services/database/sites';

/**
 * QR Code type enumeration.
 */
export enum CoreSiteQRCodeType {
    QR_CODE_DISABLED = 0, // QR code disabled value
    QR_CODE_URL = 1, // QR code type URL value
    QR_CODE_LOGIN = 2, // QR code type login value
}

// WS that we allow to call even if the site is logged out.
const ALLOWED_LOGGEDOUT_WS = [
    'core_user_remove_user_device',
];

/**
 * Class that represents a site (combination of site + user).
 * It will have all the site data and provide utility functions regarding a site.
 * To add tables to the site's database, please use registerSiteSchema exported in @services/sites.ts. This will make sure that
 * the tables are created in all the sites, not just the current one.
 *
 * @todo: Refactor this class to improve "temporary" sites support (not fully authenticated).
 */
export class CoreSite {

    static readonly REQUEST_QUEUE_FORCE_WS = false; // Use "tool_mobile_call_external_functions" even for calling a single function.

    // Constants for cache update frequency.
    static readonly FREQUENCY_USUALLY = 0;
    static readonly FREQUENCY_OFTEN = 1;
    static readonly FREQUENCY_SOMETIMES = 2;
    static readonly FREQUENCY_RARELY = 3;

    static readonly MINIMUM_MOODLE_VERSION = '3.5';

    // Versions of Moodle releases.
    static readonly MOODLE_RELEASES = {
        '3.5': 2018051700,
        '3.6': 2018120300,
        '3.7': 2019052000,
        '3.8': 2019111800,
        '3.9': 2020061500,
        '3.10': 2020110900,
        '3.11': 2021051700,
        '4.0': 2021100300, // @todo [4.0] replace with right value when released. Using a tmp value to be able to test new things.
    };

    // Possible cache update frequencies.
    protected readonly UPDATE_FREQUENCIES = [
        CoreConstants.CONFIG.cache_update_frequency_usually || 420000,
        CoreConstants.CONFIG.cache_update_frequency_often || 1200000,
        CoreConstants.CONFIG.cache_update_frequency_sometimes || 3600000,
        CoreConstants.CONFIG.cache_update_frequency_rarely || 43200000,
    ];

    // Rest of variables.
    protected logger: CoreLogger;
    protected db?: SQLiteDB;
    protected cacheTables: Record<WSGroups, AsyncInstance<CoreDatabaseTable<CoreSiteWSCacheRecord>>>;
    protected configTable: AsyncInstance<CoreDatabaseTable<CoreSiteConfigDBRecord, 'name'>>;
    protected lastViewedTable: AsyncInstance<CoreDatabaseTable<CoreSiteLastViewedDBRecord, 'component' | 'id'>>;
    protected cleanUnicode = false;
    protected lastAutoLogin = 0;
    protected offlineDisabled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected ongoingRequests: { [cacheId: string]: Promise<any> } = {};
    protected requestQueue: RequestQueueItem[] = [];
    protected requestQueueTimeout: number | null = null;
    protected tokenPluginFileWorks?: boolean;
    protected tokenPluginFileWorksPromise?: Promise<boolean>;
    protected oauthId?: number;

    /**
     * Create a site.
     *
     * @param id Site ID.
     * @param siteUrl Site URL.
     * @param token Site's WS token.
     * @param info Site info.
     * @param privateToken Private token.
     * @param config Site public config.
     * @param loggedOut Whether user is logged out.
     */
    constructor(
        public id: string | undefined,
        public siteUrl: string,
        public token?: string,
        public infos?: CoreSiteInfo,
        public privateToken?: string,
        public config?: CoreSiteConfig,
        public loggedOut?: boolean,
    ) {
        this.logger = CoreLogger.getInstance('CoreSite');
        this.siteUrl = CoreUrlUtils.removeUrlParams(this.siteUrl); // Make sure the URL doesn't have params.

        this.cacheTables = Object.values(WSGroups).reduce((tables, group) => {
            tables[group] = asyncInstance(() => CoreSites.getSiteTable(WS_CACHE_TABLES_PREFIX + group, {
                siteId: this.getId(),
                database: this.getDb(),
                config: { cachingStrategy: CoreDatabaseCachingStrategy.None },
            }));

            return tables;
        }, <Record<WSGroups, AsyncInstance<CoreDatabaseTable<CoreSiteWSCacheRecord>>>> {});

        this.configTable = asyncInstance(() => CoreSites.getSiteTable(CONFIG_TABLE, {
            siteId: this.getId(),
            database: this.getDb(),
            config: { cachingStrategy: CoreDatabaseCachingStrategy.Eager },
            primaryKeyColumns: ['name'],
        }));

        this.lastViewedTable = asyncInstance(() => CoreSites.getSiteTable(LAST_VIEWED_TABLE, {
            siteId: this.getId(),
            database: this.getDb(),
            config: { cachingStrategy: CoreDatabaseCachingStrategy.Eager },
            primaryKeyColumns: ['component', 'id'],
        }));
        this.setInfo(infos);
        this.calculateOfflineDisabled();

        if (this.id) {
            this.initDB();
        }
    }

    /**
     * Initialize the database.
     */
    initDB(): void {
        this.db = CoreDB.getDB('Site-' + this.id);
    }

    /**
     * Get site ID.
     *
     * @return Site ID.
     */
    getId(): string {
        if (this.id === undefined) {
            // Shouldn't happen for authenticated sites.
            throw new CoreError('This site doesn\'t have an ID');
        }

        return this.id;
    }

    /**
     * Get site URL.
     *
     * @return Site URL.
     */
    getURL(): string {
        return this.siteUrl;
    }

    /**
     * Get site token.
     *
     * @return Site token.
     */
    getToken(): string {
        if (this.token === undefined) {
            // Shouldn't happen for authenticated sites.
            throw new CoreError('This site doesn\'t have a token');
        }

        return this.token;
    }

    /**
     * Get site info.
     *
     * @return Site info.
     */
    getInfo(): CoreSiteInfo | undefined {
        return this.infos;
    }

    /**
     * Get site private token.
     *
     * @return Site private token.
     */
    getPrivateToken(): string | undefined {
        return this.privateToken;
    }

    /**
     * Get site DB.
     *
     * @return Site DB.
     */
    getDb(): SQLiteDB {
        if (!this.db) {
            // Shouldn't happen for authenticated sites.
            throw new CoreError('Site DB doesn\'t exist');
        }

        return this.db;
    }

    /**
     * Get site user's ID.
     *
     * @return User's ID.
     */
    getUserId(): number {
        if (!this.infos) {
            // Shouldn't happen for authenticated sites.
            throw new CoreError('Site info could not be fetched.');
        }

        return this.infos.userid;
    }

    /**
     * Get site Course ID for frontpage course. If not declared it will return 1 as default.
     *
     * @return Site Home ID.
     */
    getSiteHomeId(): number {
        return this.infos?.siteid || 1;
    }

    /**
     * Get site name.
     *
     * @return Site name.
     */
    getSiteName(): string {
        if (CoreConstants.CONFIG.sitename) {
            // Overridden by config.
            return CoreConstants.CONFIG.sitename;
        } else {
            return this.infos?.sitename || '';
        }
    }

    /**
     * Set site ID.
     *
     * @param New ID.
     */
    setId(id: string): void {
        this.id = id;
        this.initDB();
    }

    /**
     * Set site token.
     *
     * @param New token.
     */
    setToken(token: string): void {
        this.token = token;
    }

    /**
     * Set site private token.
     *
     * @param privateToken New private token.
     */
    setPrivateToken(privateToken: string): void {
        this.privateToken = privateToken;
    }

    /**
     * Check if user logged out from the site and needs to authenticate again.
     *
     * @return Whether is logged out.
     */
    isLoggedOut(): boolean {
        return !!this.loggedOut;
    }

    /**
     * Get OAuth ID.
     *
     * @return OAuth ID.
     */
    getOAuthId(): number | undefined {
        return this.oauthId;
    }

    /**
     * Set site info.
     *
     * @param New info.
     */
    setInfo(infos?: CoreSiteInfo): void {
        this.infos = infos;

        // Index function by name to speed up wsAvailable method.
        if (infos?.functions) {
            infos.functionsByName = CoreUtils.arrayToObject(infos.functions, 'name');
        }
    }

    /**
     * Set site config.
     *
     * @param config Config.
     */
    setConfig(config: CoreSiteConfig): void {
        if (config) {
            config.tool_mobile_disabledfeatures = CoreTextUtils.treatDisabledFeatures(config.tool_mobile_disabledfeatures);
        }

        this.config = config;
        this.calculateOfflineDisabled();
    }

    /**
     * Set site logged out.
     *
     * @param loggedOut True if logged out and needs to authenticate again, false otherwise.
     */
    setLoggedOut(loggedOut: boolean): void {
        this.loggedOut = !!loggedOut;
    }

    /**
     * Set OAuth ID.
     *
     * @param oauth OAuth ID.
     */
    setOAuthId(oauthId: number | undefined): void {
        this.oauthId = oauthId;
    }

    /**
     * Check if the user authenticated in the site using an OAuth method.
     *
     * @return Whether the user authenticated in the site using an OAuth method.
     */
    isOAuth(): boolean {
        return this.oauthId != null && this.oauthId !== undefined;
    }

    /**
     * Can the user access their private files?
     *
     * @return Whether can access my files.
     */
    canAccessMyFiles(): boolean {
        const info = this.getInfo();

        return !!(info && (info.usercanmanageownfiles === undefined || info.usercanmanageownfiles));
    }

    /**
     * Can the user download files?
     *
     * @return Whether can download files.
     */
    canDownloadFiles(): boolean {
        const info = this.getInfo();

        return !!info?.downloadfiles && info?.downloadfiles > 0;
    }

    /**
     * Can the user use an advanced feature?
     *
     * @param feature The name of the feature.
     * @param whenUndefined The value to return when the parameter is undefined.
     * @return Whether can use advanced feature.
     */
    canUseAdvancedFeature(featureName: string, whenUndefined: boolean = true): boolean {
        const info = this.getInfo();

        if (info?.advancedfeatures === undefined) {
            return whenUndefined;
        }

        const feature = info.advancedfeatures.find((item) => item.name === featureName);

        if (!feature) {
            return whenUndefined;
        }

        return feature.value !== 0;
    }

    /**
     * Can the user upload files?
     *
     * @return Whether can upload files.
     */
    canUploadFiles(): boolean {
        const info = this.getInfo();

        return !!info?.uploadfiles && info?.uploadfiles > 0;
    }

    /**
     * Fetch site info from the Moodle site.
     *
     * @return A promise to be resolved when the site info is retrieved.
     */
    fetchSiteInfo(): Promise<CoreSiteInfoResponse> {
        // The get_site_info WS call won't be cached.
        const preSets = {
            getFromCache: false,
            saveToCache: false,
            skipQueue: true,
        };

        // Reset clean Unicode to check if it's supported again.
        this.cleanUnicode = false;

        return this.read('core_webservice_get_site_info', {}, preSets);
    }

    /**
     * Read some data from the Moodle site using WS. Requests are cached by default.
     *
     * @param method WS method to use.
     * @param data Data to send to the WS.
     * @param preSets Extra options.
     * @return Promise resolved with the response, rejected with CoreWSError if it fails.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    read<T = unknown>(method: string, data: any, preSets?: CoreSiteWSPreSets): Promise<T> {
        preSets = preSets || {};
        if (preSets.getFromCache === undefined) {
            preSets.getFromCache = true;
        }
        if (preSets.saveToCache === undefined) {
            preSets.saveToCache = true;
        }
        if (preSets.reusePending === undefined) {
            preSets.reusePending = true;
        }

        return this.request(method, data, preSets);
    }

    /**
     * Sends some data to the Moodle site using WS. Requests are NOT cached by default.
     *
     * @param method WS method to use.
     * @param data Data to send to the WS.
     * @param preSets Extra options.
     * @return Promise resolved with the response, rejected with CoreWSError if it fails.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write<T = unknown>(method: string, data: any, preSets?: CoreSiteWSPreSets): Promise<T> {
        preSets = preSets || {};
        if (preSets.getFromCache === undefined) {
            preSets.getFromCache = false;
        }
        if (preSets.saveToCache === undefined) {
            preSets.saveToCache = false;
        }
        if (preSets.emergencyCache === undefined) {
            preSets.emergencyCache = false;
        }

        return this.request(method, data, preSets);
    }

    /**
     * WS request to the site.
     *
     * @param method The WebService method to be called.
     * @param data Arguments to pass to the method.
     * @param preSets Extra options.
     * @param retrying True if we're retrying the call for some reason. This is to prevent infinite loops.
     * @return Promise resolved with the response, rejected with CoreWSError if it fails.
     * @description
     *
     * Sends a webservice request to the site. This method will automatically add the
     * required parameters and pass it on to the low level API in CoreWSProvider.call().
     *
     * Caching is also implemented, when enabled this method will returned a cached version of the request if the
     * data hasn't expired.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async request<T = unknown>(method: string, data: any, preSets: CoreSiteWSPreSets, retrying?: boolean): Promise<T> {
        if (this.isLoggedOut() && !ALLOWED_LOGGEDOUT_WS.includes(method)) {
            // Site is logged out, it cannot call WebServices.
            CoreEvents.trigger(CoreEvents.SESSION_EXPIRED, {}, this.id);

            // Use a silent error, the SESSION_EXPIRED event will display a message if needed.
            throw new CoreSilentError(Translate.instant('core.lostconnection'));
        }

        const initialToken = this.token || '';
        data = data || {};

        if (!CoreNetwork.isOnline() && this.offlineDisabled) {
            throw new CoreError(Translate.instant('core.errorofflinedisabled'));
        }

        // Check if the method is available.
        // We ignore this check when we do not have the site info, as the list of functions is not loaded yet.
        if (this.getInfo() && !this.wsAvailable(method)) {
            this.logger.error(`WS function '${method}' is not available.`);

            throw new CoreError(Translate.instant('core.wsfunctionnotavailable'));
        }

        const wsPreSets: CoreWSPreSets = {
            wsToken: this.token || '',
            siteUrl: this.siteUrl,
            cleanUnicode: this.cleanUnicode,
            typeExpected: preSets.typeExpected,
            responseExpected: preSets.responseExpected,
            splitRequest: preSets.splitRequest,
        };

        if (wsPreSets.cleanUnicode && CoreTextUtils.hasUnicodeData(data)) {
            // Data will be cleaned, notify the user.
            CoreDomUtils.showToast('core.unicodenotsupported', true, ToastDuration.LONG);
        } else {
            // No need to clean data in this call.
            wsPreSets.cleanUnicode = false;
        }

        if (this.offlineDisabled) {
            // Offline is disabled, don't use cache.
            preSets.getFromCache = false;
            preSets.saveToCache = false;
            preSets.emergencyCache = false;
        }

        // Enable text filtering by default.
        data.moodlewssettingfilter = preSets.filter === false ? false : true;
        data.moodlewssettingfileurl = preSets.rewriteurls === false ? false : true;

        // Convert arguments to strings before starting the cache process.
        data = CoreWS.convertValuesToString(data, wsPreSets.cleanUnicode);
        if (data == null) {
            // Empty cleaned text found.
            throw new CoreError(Translate.instant('core.unicodenotsupportedcleanerror'));
        }

        const cacheId = this.getCacheId(method, data);

        // Check for an ongoing identical request if we're not ignoring cache.
        if (preSets.getFromCache && this.ongoingRequests[cacheId] !== undefined) {
            const response = await this.ongoingRequests[cacheId];

            // Clone the data, this may prevent errors if in the callback the object is modified.
            return CoreUtils.clone(response);
        }

        const promise = this.getFromCache<T>(method, data, preSets, false).catch(async () => {
            if (preSets.forceOffline) {
                // Don't call the WS, just fail.
                throw new CoreError(
                    Translate.instant('core.cannotconnect', { $a: CoreSite.MINIMUM_MOODLE_VERSION }),
                );
            }

            // Call the WS.
            try {
                if (method !== 'core_webservice_get_site_info') {
                    // Send the language to use. Do it after checking cache to prevent losing offline data when changing language.
                    // Don't send it to core_webservice_get_site_info, that WS is used to check if Moodle version is supported.
                    data.moodlewssettinglang = preSets.lang ?? await CoreLang.getCurrentLanguage();
                    // Moodle uses underscore instead of dash.
                    data.moodlewssettinglang = data.moodlewssettinglang.replace('-', '_');
                }

                const response = await this.callOrEnqueueRequest<T>(method, data, preSets, wsPreSets);

                if (preSets.saveToCache) {
                    delete data.moodlewssettinglang;
                    this.saveToCache(method, data, response, preSets);
                }

                return response;
            } catch (error) {
                let useSilentError = false;

                if (CoreUtils.isExpiredTokenError(error)) {
                    if (initialToken !== this.token && !retrying) {
                        // Token has changed, retry with the new token.
                        preSets.getFromCache = false; // Don't check cache now. Also, it will skip ongoingRequests.

                        return this.request<T>(method, data, preSets, true);
                    } else if (CoreApp.isSSOAuthenticationOngoing()) {
                        // There's an SSO authentication ongoing, wait for it to finish and try again.
                        await CoreApp.waitForSSOAuthentication();

                        return this.request<T>(method, data, preSets, true);
                    }

                    // Session expired, trigger event.
                    CoreEvents.trigger(CoreEvents.SESSION_EXPIRED, {}, this.id);
                    // Change error message. Try to get data from cache, the event will handle the error.
                    error.message = Translate.instant('core.lostconnection');
                    useSilentError = true; // Use a silent error, the SESSION_EXPIRED event will display a message if needed.
                } else if (error.errorcode === 'userdeleted' || error.errorcode === 'wsaccessuserdeleted') {
                    // User deleted, trigger event.
                    CoreEvents.trigger(CoreEvents.USER_DELETED, { params: data }, this.id);
                    error.message = Translate.instant('core.userdeleted');

                    throw new CoreWSError(error);
                } else if (error.errorcode === 'wsaccessusersuspended') {
                    // User suspended, trigger event.
                    CoreEvents.trigger(CoreEvents.USER_SUSPENDED, { params: data }, this.id);
                    error.message = Translate.instant('core.usersuspended');

                    throw new CoreWSError(error);
                } else if (error.errorcode === 'wsaccessusernologin') {
                    // User suspended, trigger event.
                    CoreEvents.trigger(CoreEvents.USER_NO_LOGIN, { params: data }, this.id);
                    error.message = Translate.instant('core.usernologin');

                    throw new CoreWSError(error);
                } else if (error.errorcode === 'forcepasswordchangenotice') {
                    // Password Change Forced, trigger event. Try to get data from cache, the event will handle the error.
                    CoreEvents.trigger(CoreEvents.PASSWORD_CHANGE_FORCED, {}, this.id);
                    error.message = Translate.instant('core.forcepasswordchangenotice');
                } else if (error.errorcode === 'usernotfullysetup') {
                    // User not fully setup, trigger event. Try to get data from cache, the event will handle the error.
                    CoreEvents.trigger(CoreEvents.USER_NOT_FULLY_SETUP, {}, this.id);
                    error.message = Translate.instant('core.usernotfullysetup');
                } else if (error.errorcode === 'sitepolicynotagreed') {
                    // Site policy not agreed, trigger event.
                    CoreEvents.trigger(CoreEvents.SITE_POLICY_NOT_AGREED, {}, this.id);
                    error.message = Translate.instant('core.login.sitepolicynotagreederror');

                    throw new CoreWSError(error);
                } else if (error.errorcode === 'dmlwriteexception' && CoreTextUtils.hasUnicodeData(data)) {
                    if (!this.cleanUnicode) {
                        // Try again cleaning unicode.
                        this.cleanUnicode = true;

                        return this.request<T>(method, data, preSets);
                    }
                    // This should not happen.
                    error.message = Translate.instant('core.unicodenotsupported');

                    throw new CoreWSError(error);
                } else if (error.exception === 'required_capability_exception' || error.errorcode === 'nopermission' ||
                        error.errorcode === 'notingroup') {
                    // Translate error messages with missing strings.
                    if (error.message === 'error/nopermission') {
                        error.message = Translate.instant('core.nopermissionerror');
                    } else if (error.message === 'error/notingroup') {
                        error.message = Translate.instant('core.notingroup');
                    }

                    // Save the error instead of deleting the cache entry so the same content is displayed in offline.
                    this.saveToCache(method, data, error, preSets);

                    throw new CoreWSError(error);
                } else if (preSets.cacheErrors && preSets.cacheErrors.indexOf(error.errorcode) != -1) {
                    // Save the error instead of deleting the cache entry so the same content is displayed in offline.
                    this.saveToCache(method, data, error, preSets);

                    throw new CoreWSError(error);
                } else if (preSets.emergencyCache !== undefined && !preSets.emergencyCache) {
                    this.logger.debug(`WS call '${method}' failed. Emergency cache is forbidden, rejecting.`);

                    throw new CoreWSError(error);
                }

                if (preSets.deleteCacheIfWSError && CoreUtils.isWebServiceError(error)) {
                    // Delete the cache entry and return the entry. Don't block the user with the delete.
                    CoreUtils.ignoreErrors(this.deleteFromCache(method, data, preSets));

                    throw new CoreWSError(error);
                }

                this.logger.debug(`WS call '${method}' failed. Trying to use the emergency cache.`);
                preSets.omitExpires = true;
                preSets.getFromCache = true;

                try {
                    return await this.getFromCache<T>(method, data, preSets, true);
                } catch {
                    if (useSilentError) {
                        throw new CoreSilentError(error.message);
                    }

                    throw new CoreWSError(error);
                }
            }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }).then((response: any) => {
            // Check if the response is an error, this happens if the error was stored in the cache.
            if (response && (response.exception !== undefined || response.errorcode !== undefined)) {
                throw new CoreWSError(response);
            }

            return response;
        });

        this.ongoingRequests[cacheId] = promise;

        // Clear ongoing request after setting the promise (just in case it's already resolved).
        try {
            const response = await promise;

            // We pass back a clone of the original object, this may prevent errors if in the callback the object is modified.
            return CoreUtils.clone(response);
        } finally {
            // Make sure we don't clear the promise of a newer request that ignores the cache.
            if (this.ongoingRequests[cacheId] === promise) {
                delete this.ongoingRequests[cacheId];
            }
        }
    }

    /**
     * Adds a request to the queue or calls it immediately when not using the queue.
     *
     * @param method The WebService method to be called.
     * @param data Arguments to pass to the method.
     * @param preSets Extra options related to the site.
     * @param wsPreSets Extra options related to the WS call.
     * @return Promise resolved with the response when the WS is called.
     */
    protected callOrEnqueueRequest<T = unknown>(
        method: string,
        data: any, // eslint-disable-line @typescript-eslint/no-explicit-any
        preSets: CoreSiteWSPreSets,
        wsPreSets: CoreWSPreSets,
    ): Promise<T> {
        if (preSets.skipQueue || !this.wsAvailable('tool_mobile_call_external_functions')) {
            return CoreWS.call<T>(method, data, wsPreSets);
        }

        const cacheId = this.getCacheId(method, data);

        // Check if there is an identical request waiting in the queue (read requests only by default).
        if (preSets.reusePending) {
            const request = this.requestQueue.find((request) => request.cacheId == cacheId);
            if (request) {
                return request.deferred;
            }
        }

        const request: RequestQueueItem<T> = {
            cacheId,
            method,
            data,
            preSets,
            wsPreSets,
            deferred: new CorePromisedValue(),
        };

        return this.enqueueRequest(request);
    }

    /**
     * Adds a request to the queue.
     *
     * @param request The request to enqueue.
     * @return Promise resolved with the response when the WS is called.
     */
    protected enqueueRequest<T>(request: RequestQueueItem<T>): Promise<T> {
        this.requestQueue.push(request);

        if (this.requestQueue.length >= CoreConstants.CONFIG.wsrequestqueuelimit) {
            this.processRequestQueue();
        } else if (!this.requestQueueTimeout) {
            this.requestQueueTimeout = window.setTimeout(
                this.processRequestQueue.bind(this),
                CoreConstants.CONFIG.wsrequestqueuedelay,
            );
        }

        return request.deferred;
    }

    /**
     * Call the enqueued web service requests.
     */
    protected async processRequestQueue(): Promise<void> {
        this.logger.debug(`Processing request queue (${this.requestQueue.length} requests)`);

        // Clear timeout if set.
        if (this.requestQueueTimeout) {
            clearTimeout(this.requestQueueTimeout);
            this.requestQueueTimeout = null;
        }

        // Extract all requests from the queue.
        const requests = this.requestQueue;
        this.requestQueue = [];

        if (requests.length == 1 && !CoreSite.REQUEST_QUEUE_FORCE_WS) {
            // Only one request, do a regular web service call.
            try {
                const data = await CoreWS.call(requests[0].method, requests[0].data, requests[0].wsPreSets);

                requests[0].deferred.resolve(data);
            } catch (error) {
                requests[0].deferred.reject(error);
            }

            return;
        }

        let lang: string | undefined;
        const requestsData: Record<string, unknown> = {
            requests: requests.map((request) => {
                const args = {};
                const settings = {};

                // Separate WS settings from function arguments.
                Object.keys(request.data).forEach((key) => {
                    let value = request.data[key];
                    const match = /^moodlews(setting.*)$/.exec(key);
                    if (match) {
                        if (match[1] == 'settingfilter' || match[1] == 'settingfileurl') {
                            // Undo special treatment of these settings in CoreWSProvider.convertValuesToString.
                            value = (value == 'true' ? '1' : '0');
                        } else if (match[1] == 'settinglang') {
                            // Use the lang globally to avoid exceptions with languages not installed.
                            lang = value;

                            return;
                        }
                        settings[match[1]] = value;
                    } else {
                        args[key] = value;
                    }
                });

                return {
                    function: request.method,
                    arguments: JSON.stringify(args),
                    ...settings,
                };
            }),
        };
        requestsData.moodlewssettinglang = lang;

        const wsPresets: CoreWSPreSets = {
            siteUrl: this.siteUrl,
            wsToken: this.token || '',
        };

        try {
            const data = await CoreWS.call<CoreSiteCallExternalFunctionsResult>(
                'tool_mobile_call_external_functions',
                requestsData,
                wsPresets,
            );

            if (!data || !data.responses) {
                throw new CoreError(Translate.instant('core.errorinvalidresponse'));
            }

            requests.forEach((request, i) => {
                const response = data.responses[i];

                if (!response) {
                    // Request not executed, enqueue again.
                    this.enqueueRequest(request);
                } else if (response.error) {
                    request.deferred.reject(CoreTextUtils.parseJSON(response.exception || ''));
                } else {
                    let responseData = response.data ? CoreTextUtils.parseJSON(response.data) : {};
                    // Match the behaviour of CoreWSProvider.call when no response is expected.
                    const responseExpected = wsPresets.responseExpected === undefined || wsPresets.responseExpected;
                    if (!responseExpected && (responseData == null || responseData === '')) {
                        responseData = {};
                    }
                    request.deferred.resolve(responseData);
                }
            });
        } catch (error) {
            // Error not specific to a single request, reject all promises.
            requests.forEach((request) => {
                request.deferred.reject(error);
            });
        }
    }

    /**
     * Check if a WS is available in this site.
     *
     * @param method WS name.
     * @return Whether the WS is available.
     */
    wsAvailable(method: string): boolean {
        return !!this.infos?.functionsByName?.[method];
    }

    /**
     * Get cache ID.
     *
     * @param method The WebService method.
     * @param data Arguments to pass to the method.
     * @return Cache ID.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected getCacheId(method: string, data: any): string {
        return <string> Md5.hashAsciiStr(method + ':' + CoreUtils.sortAndStringify(data));
    }

    /**
     * Get a WS response from cache.
     *
     * @param method The WebService method to be called.
     * @param data Arguments to pass to the method.
     * @param preSets Extra options.
     * @param emergency Whether it's an "emergency" cache call (WS call failed).
     * @param originalData Arguments to pass to the method before being converted to strings.
     * @return Promise resolved with the WS response.
     */
    protected async getFromCache<T = unknown>(
        method: string,
        data: any, // eslint-disable-line @typescript-eslint/no-explicit-any
        preSets: CoreSiteWSPreSets,
        emergency?: boolean,
    ): Promise<T> {
        if (!this.db || !preSets.getFromCache) {
            throw new CoreError('Get from cache is disabled.');
        }

        const id = this.getCacheId(method, data);
        const group = this.getWSGroupFromWSName(method);
        let entry: CoreSiteWSCacheRecord | undefined;

        if (preSets.getCacheUsingCacheKey || (emergency && preSets.getEmergencyCacheUsingCacheKey)) {
            const entries = await this.cacheTables[group].getMany({ key: preSets.cacheKey });

            if (!entries.length) {
                // Cache key not found, get by params sent.
                entry = await this.cacheTables[group].getOneByPrimaryKey({ id });
            } else {
                if (entries.length > 1) {
                    // More than one entry found. Search the one with same ID as this call.
                    entry = entries.find((entry) => entry.id == id);
                }

                if (!entry) {
                    entry = entries[0];
                }
            }
        } else {
            entry = await this.cacheTables[group].getOneByPrimaryKey({ id });
        }

        if (entry === undefined) {
            throw new CoreError('Cache entry not valid.');
        }

        const now = Date.now();
        let expirationTime: number | undefined;

        preSets.omitExpires = preSets.omitExpires || preSets.forceOffline || !CoreNetwork.isOnline();

        if (!preSets.omitExpires) {
            expirationTime = entry.expirationTime + this.getExpirationDelay(preSets.updateFrequency);

            if (now > expirationTime) {
                this.logger.debug('Cached element found, but it is expired');

                throw new CoreError('Cache entry is expired.');
            }
        }

        if (entry.data !== undefined) {
            if (!expirationTime) {
                this.logger.info(`Cached element found, id: ${id}. Expiration time ignored.`);
            } else {
                const expires = (expirationTime - now) / 1000;
                this.logger.info(`Cached element found, id: ${id}. Expires in expires in ${expires} seconds`);
            }

            return <T> CoreTextUtils.parseJSON(entry.data, {});
        }

        throw new CoreError('Cache entry not valid.');
    }

    /**
     * Get WS group based on a WS name.
     *
     * @return WS group.
     */
    protected getWSGroupFromWSName(name: string): WSGroups {
        if (name.startsWith('mod_')) {
            return WSGroups.MOD;
        } else if (name.startsWith('tool_')) {
            return WSGroups.TOOL;
        } else if (name.startsWith('block_') || name.startsWith('core_block_')) {
            return WSGroups.BLOCK;
        } else if (name.startsWith('core_')) {
            return WSGroups.CORE;
        } else {
            return WSGroups.OTHER;
        }
    }

    /**
     * Gets the size of cached data for a specific component or component instance.
     *
     * @param component Component name
     * @param componentId Optional component id (if not included, returns sum for whole component)
     * @return Promise resolved when we have calculated the size
     */
    async getComponentCacheSize(component: string, componentId?: number): Promise<number> {
        const params: Array<string | number> = [component];
        let extraClause = '';
        if (componentId !== undefined && componentId !== null) {
            params.push(componentId);
            extraClause = ' AND componentId = ?';
        }

        const sizes = await Promise.all(Object.values(this.cacheTables).map(table => table.reduce(
            {
                sql: 'SUM(length(data))',
                js: (size, record) => size + record.data.length,
                jsInitialValue: 0,
            },
            {
                sql: 'WHERE component = ?' + extraClause,
                sqlParams: params,
                js: record => record.component === component && (params.length === 1 || record.componentId === componentId),
            },
        )));

        return sizes.reduce((totalSize, size) => totalSize + size, 0);
    }

    /**
     * Save a WS response to cache.
     *
     * @param method The WebService method.
     * @param data Arguments to pass to the method.
     * @param response The WS response.
     * @param preSets Extra options.
     * @return Promise resolved when the response is saved.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected async saveToCache(method: string, data: any, response: any, preSets: CoreSiteWSPreSets): Promise<void> {
        if (preSets.uniqueCacheKey) {
            // Cache key must be unique, delete all entries with same cache key.
            await CoreUtils.ignoreErrors(this.deleteFromCache(method, data, preSets, true));
        }

        // Since 3.7, the expiration time contains the time the entry is modified instead of the expiration time.
        // We decided to reuse this field to prevent modifying the database table.
        const id = this.getCacheId(method, data);
        const group = this.getWSGroupFromWSName(method);
        const entry = {
            id,
            data: JSON.stringify(response),
            expirationTime: Date.now(),
        };

        if (preSets.cacheKey) {
            entry['key'] = preSets.cacheKey;
        }

        if (preSets.component) {
            entry['component'] = preSets.component;
            if (preSets.componentId) {
                entry['componentId'] = preSets.componentId;
            }
        }

        await this.cacheTables[group].insert(entry);
    }

    /**
     * Delete a WS cache entry or entries.
     *
     * @param method The WebService method to be called.
     * @param data Arguments to pass to the method.
     * @param preSets Extra options.
     * @param allCacheKey True to delete all entries with the cache key, false to delete only by ID.
     * @return Promise resolved when the entries are deleted.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected async deleteFromCache(method: string, data: any, preSets: CoreSiteWSPreSets, allCacheKey?: boolean): Promise<void> {
        const id = this.getCacheId(method, data);
        const group = this.getWSGroupFromWSName(method);

        if (allCacheKey) {
            await this.cacheTables[group].delete({ key: preSets.cacheKey });
        } else {
            await this.cacheTables[group].deleteByPrimaryKey({ id });
        }
    }

    /**
     * Deletes WS cache entries for all methods relating to a specific component (and
     * optionally component id).
     *
     * @param component Component name.
     * @param componentId Component id.
     * @return Promise resolved when the entries are deleted.
     */
    async deleteComponentFromCache(component: string, componentId?: number): Promise<void> {
        if (!component) {
            return;
        }

        const params = { component };

        if (componentId) {
            params['componentId'] = componentId;
        }

        await Promise.all(Object.values(this.cacheTables).map(table => table.delete(params)));
    }

    /*
     * Uploads a file using Cordova File API.
     *
     * @param filePath File path.
     * @param options File upload options.
     * @param onProgress Function to call on progress.
     * @return Promise resolved when uploaded.
     */
    uploadFile(
        filePath: string,
        options: CoreWSFileUploadOptions,
        onProgress?: (event: ProgressEvent) => void,
    ): Promise<CoreWSUploadFileResult> {
        if (!options.fileArea) {
            options.fileArea = 'draft';
        }

        return CoreWS.uploadFile(filePath, options, {
            siteUrl: this.siteUrl,
            wsToken: this.token || '',
        }, onProgress);
    }

    /**
     * Invalidates all the cache entries.
     *
     * @return Promise resolved when the cache entries are invalidated.
     */
    async invalidateWsCache(): Promise<void> {
        this.logger.debug('Invalidate all the cache for site: ' + this.id);

        try {
            await Promise.all(Object.values(this.cacheTables).map(table => table.update({ expirationTime: 0 })));
        } finally {
            CoreEvents.trigger(CoreEvents.WS_CACHE_INVALIDATED, {}, this.getId());
        }
    }

    /**
     * Invalidates all the cache entries with a certain key.
     *
     * @param key Key to search.
     * @return Promise resolved when the cache entries are invalidated.
     */
    async invalidateWsCacheForKey(key: string): Promise<void> {
        if (!key) {
            return;
        }

        this.logger.debug('Invalidate cache for key: ' + key);

        await Promise.all(Object.values(this.cacheTables).map(table => table.update({ expirationTime: 0 }, { key })));
    }

    /**
     * Invalidates all the cache entries in an array of keys.
     *
     * @param keys Keys to search.
     * @return Promise resolved when the cache entries are invalidated.
     */
    async invalidateMultipleWsCacheForKey(keys: string[]): Promise<void> {
        if (!this.db) {
            throw new CoreError('Site DB not initialized');
        }
        if (!keys || !keys.length) {
            return;
        }

        this.logger.debug('Invalidating multiple cache keys');
        await Promise.all(keys.map((key) => this.invalidateWsCacheForKey(key)));
    }

    /**
     * Invalidates all the cache entries whose key starts with a certain value.
     *
     * @param key Key to search.
     * @return Promise resolved when the cache entries are invalidated.
     */
    async invalidateWsCacheForKeyStartingWith(key: string): Promise<void> {
        if (!key) {
            return;
        }

        this.logger.debug('Invalidate cache for key starting with: ' + key);

        await Promise.all(Object.values(this.cacheTables).map(table => table.updateWhere({ expirationTime: 0 }, {
            sql: 'key LIKE ?',
            sqlParams: [key + '%'],
            js: record => !!record.key?.startsWith(key),
        })));
    }

    /**
     * Check if tokenpluginfile can be used, and fix the URL afterwards.
     *
     * @param url The url to be fixed.
     * @return Promise resolved with the fixed URL.
     */
    checkAndFixPluginfileURL(url: string): Promise<string> {
        return this.checkTokenPluginFile(url).then(() => this.fixPluginfileURL(url));
    }

    /**
     * Generic function for adding the wstoken to Moodle urls and for pointing to the correct script.
     * Uses CoreUtilsProvider.fixPluginfileURL, passing site's token.
     *
     * @param url The url to be fixed.
     * @return Fixed URL.
     */
    fixPluginfileURL(url: string): string {
        const accessKey = this.tokenPluginFileWorks || this.tokenPluginFileWorks === undefined ?
            this.infos && this.infos.userprivateaccesskey : undefined;

        return CoreUrlUtils.fixPluginfileURL(url, this.token || '', this.siteUrl, accessKey);
    }

    /**
     * Deletes site's DB.
     *
     * @return Promise to be resolved when the DB is deleted.
     */
    async deleteDB(): Promise<void> {
        await CoreDB.deleteDB('Site-' + this.id);
    }

    /**
     * Deletes site's folder.
     *
     * @return Promise to be resolved when the DB is deleted.
     */
    async deleteFolder(): Promise<void> {
        if (!CoreFile.isAvailable() || !this.id) {
            return;
        }

        const siteFolder = CoreFile.getSiteFolder(this.id);

        // Ignore any errors, removeDir fails if folder doesn't exists.
        await CoreUtils.ignoreErrors(CoreFile.removeDir(siteFolder));
    }

    /**
     * Get space usage of the site.
     *
     * @return Promise resolved with the site space usage (size).
     */
    getSpaceUsage(): Promise<number> {
        if (CoreFile.isAvailable() && this.id) {
            const siteFolderPath = CoreFile.getSiteFolder(this.id);

            return CoreFile.getDirectorySize(siteFolderPath).catch(() => 0);
        } else {
            return Promise.resolve(0);
        }
    }

    /**
     * Gets an approximation of the cache tables usage of the site.
     *
     * Currently this is just the total length of the data fields in the cache tables.
     *
     * @return Promise resolved with the total size of all data in the cache tables (bytes)
     */
    async getCacheUsage(): Promise<number> {
        const sizes = await Promise.all(Object.values(this.cacheTables).map(table => table.reduce({
            sql: 'SUM(length(data))',
            js: (size, record) => size + record.data.length,
            jsInitialValue: 0,
        })));

        return sizes.reduce((totalSize, size) => totalSize + size, 0);
    }

    /**
     * Gets a total of the file and cache usage.
     *
     * @return Promise with the total of getSpaceUsage and getCacheUsage
     */
    async getTotalUsage(): Promise<number> {
        const space = await this.getSpaceUsage();
        const cache = await this.getCacheUsage();

        console.log("log here");
        return space + cache;
    }

    /**
     * Returns the URL to the documentation of the app, based on Moodle version and current language.
     *
     * @param page Docs page to go to.
     * @return Promise resolved with the Moodle docs URL.
     */
    getDocsUrl(page?: string): Promise<string> {
        const release = this.infos?.release ? this.infos.release : undefined;

        return CoreUrlUtils.getDocsUrl(release, page);
    }

    /**
     * Returns a url to link an specific page on the site.
     *
     * @param path Path of the url to go to.
     * @param params Object with the params to add.
     * @param anchor Anchor text if needed.
     * @return URL with params.
     */
    createSiteUrl(path: string, params?: CoreUrlParams, anchor?: string): string {
        return CoreUrlUtils.addParamsToUrl(this.siteUrl + path, params, anchor);
    }

    /**
     * Check if the local_mobile plugin is installed in the Moodle site.
     *
     * @return Promise resolved when the check is done.
     * @deprecated since app 4.0
     */
    async checkLocalMobilePlugin(): Promise<LocalMobileResponse> {
        // Not used anymore.
        return { code: 0, coreSupported: true };
    }

    /**
     * Check if local_mobile has been installed in Moodle.
     *
     * @return Whether the App is able to use local_mobile plugin for this site.
     * @deprecated since app 4.0
     */
    checkIfAppUsesLocalMobile(): boolean {
        return false;
    }

    /**
     * Check if local_mobile has been installed in Moodle but the app is not using it.
     *
     * @return Promise resolved it local_mobile was added, rejected otherwise.
     * @deprecated since app 4.0
     */
    async checkIfLocalMobileInstalledAndNotUsed(): Promise<void> {
        throw new CoreError('Deprecated.');
    }

    /**
     * Check if a URL belongs to this site.
     *
     * @param url URL to check.
     * @return Whether the URL belongs to this site.
     */
    containsUrl(url?: string): boolean {
        if (!url) {
            return false;
        }

        const siteUrl = CoreTextUtils.addEndingSlash(CoreUrlUtils.removeProtocolAndWWW(this.siteUrl));
        url = CoreTextUtils.addEndingSlash(CoreUrlUtils.removeProtocolAndWWW(url));

        return url.indexOf(siteUrl) == 0;
    }

    /**
     * Get the public config of this site.
     *
     * @param options Options.
     * @return Promise resolved with public config. Rejected with an object if error, see CoreWSProvider.callAjax.
     */
    async getPublicConfig(options: { readingStrategy?: CoreSitesReadingStrategy } = {}): Promise<CoreSitePublicConfigResponse> {
        if (!this.db) {
            return this.requestPublicConfig();
        }

        const method = 'tool_mobile_get_public_config';
        const cacheId = this.getCacheId(method, {});
        const cachePreSets: CoreSiteWSPreSets = {
            getFromCache: true,
            saveToCache: true,
            emergencyCache: true,
            cacheKey: this.getPublicConfigCacheKey(),
            ...CoreSites.getReadingStrategyPreSets(options.readingStrategy),
        };

        if (this.offlineDisabled) {
            // Offline is disabled, don't use cache.
            cachePreSets.getFromCache = false;
            cachePreSets.saveToCache = false;
            cachePreSets.emergencyCache = false;
        }

        // Check for an ongoing identical request if we're not ignoring cache.
        if (cachePreSets.getFromCache && this.ongoingRequests[cacheId] !== undefined) {
            const response = await this.ongoingRequests[cacheId];

            return response;
        }

        const promise = this.getFromCache<CoreSitePublicConfigResponse>(method, {}, cachePreSets, false).catch(async () => {
            if (cachePreSets.forceOffline) {
                // Don't call the WS, just fail.
                throw new CoreError(
                    Translate.instant('core.cannotconnect', { $a: CoreSite.MINIMUM_MOODLE_VERSION }),
                );
            }

            // Call the WS.
            try {
                const config = await this.requestPublicConfig();

                if (cachePreSets.saveToCache) {
                    this.saveToCache(method, {}, config, cachePreSets);
                }

                return config;
            } catch (error) {
                cachePreSets.omitExpires = true;
                cachePreSets.getFromCache = true;

                try {
                    return await this.getFromCache<CoreSitePublicConfigResponse>(method, {}, cachePreSets, true);
                } catch {
                    throw error;
                }
            }
        });

        this.ongoingRequests[cacheId] = promise;

        // Clear ongoing request after setting the promise (just in case it's already resolved).
        try {
            const response = await promise;

            // We pass back a clone of the original object, this may prevent errors if in the callback the object is modified.
            return response;
        } finally {
            // Make sure we don't clear the promise of a newer request that ignores the cache.
            if (this.ongoingRequests[cacheId] === promise) {
                delete this.ongoingRequests[cacheId];
            }
        }
    }

    /**
     * Get cache key for getPublicConfig WS calls.
     *
     * @return Cache key.
     */
    protected getPublicConfigCacheKey(): string {
        return 'tool_mobile_get_public_config';
    }

    /**
     * Perform a request to the server to get the public config of this site.
     *
     * @return Promise resolved with public config.
     */
    protected async requestPublicConfig(): Promise<CoreSitePublicConfigResponse> {
        const preSets: CoreWSAjaxPreSets = {
            siteUrl: this.siteUrl,
        };

        let config: CoreSitePublicConfigResponse;

        try {
            config = await CoreWS.callAjax<CoreSitePublicConfigResponse>('tool_mobile_get_public_config', {}, preSets);
        } catch (error) {
            if (!error || error.errorcode !== 'codingerror' || (this.getInfo() && !this.isVersionGreaterEqualThan('3.8'))) {
                throw error;
            }

            // This error probably means that there is a redirect in the site. Try to use a GET request.
            preSets.noLogin = true;
            preSets.useGet = true;

            try {
                config = await CoreWS.callAjax<CoreSitePublicConfigResponse>('tool_mobile_get_public_config', {}, preSets);
            } catch (error2) {
                if (this.getInfo() && this.isVersionGreaterEqualThan('3.8')) {
                    // GET is supported, return the second error.
                    throw error2;
                } else {
                    // GET not supported or we don't know if it's supported. Return first error.
                    throw error;
                }
            }
        }

        // Use the wwwroot returned by the server.
        if (config.httpswwwroot) {
            this.siteUrl = CoreUrlUtils.removeUrlParams(config.httpswwwroot); // Make sure the URL doesn't have params.
        }

        return config;
    }

    /**
     * Open a URL in browser using auto-login in the Moodle site if available.
     *
     * @param url The URL to open.
     * @param alertMessage If defined, an alert will be shown before opening the browser.
     * @param options Other options.
     * @return Promise resolved when done, rejected otherwise.
     */
    async openInBrowserWithAutoLogin(
        url: string,
        alertMessage?: string,
        options: CoreUtilsOpenInBrowserOptions = {},
    ): Promise<void> {
        await this.openWithAutoLogin(false, url, options, alertMessage);
    }

    /**
     * Open a URL in browser using auto-login in the Moodle site if available and the URL belongs to the site.
     *
     * @param url The URL to open.
     * @param alertMessage If defined, an alert will be shown before opening the browser.
     * @param options Other options.
     * @return Promise resolved when done, rejected otherwise.
     * @deprecated since 4.1. Use openInBrowserWithAutoLogin instead, now it always checks that URL belongs to same site.
     */
    async openInBrowserWithAutoLoginIfSameSite(
        url: string,
        alertMessage?: string,
        options: CoreUtilsOpenInBrowserOptions = {},
    ): Promise<void> {
        return this.openInBrowserWithAutoLogin(url, alertMessage, options);
    }

    /**
     * Open a URL in inappbrowser using auto-login in the Moodle site if available.
     *
     * @param url The URL to open.
     * @param options Override default options passed to InAppBrowser.
     * @param alertMessage If defined, an alert will be shown before opening the inappbrowser.
     * @return Promise resolved when done.
     */
    async openInAppWithAutoLogin(url: string, options?: InAppBrowserOptions, alertMessage?: string): Promise<InAppBrowserObject> {
        const iabInstance = <InAppBrowserObject> await this.openWithAutoLogin(true, url, options, alertMessage);

        return iabInstance;
    }

    /**
     * Open a URL in inappbrowser using auto-login in the Moodle site if available and the URL belongs to the site.
     *
     * @param url The URL to open.
     * @param options Override default options passed to inappbrowser.
     * @param alertMessage If defined, an alert will be shown before opening the inappbrowser.
     * @return Promise resolved when done.
     * @deprecated since 4.1. Use openInAppWithAutoLogin instead, now it always checks that URL belongs to same site.
     */
    async openInAppWithAutoLoginIfSameSite(
        url: string,
        options?: InAppBrowserOptions,
        alertMessage?: string,
    ): Promise<InAppBrowserObject> {
        return this.openInAppWithAutoLogin(url, options, alertMessage);
    }

    /**
     * Open a URL in browser or InAppBrowser using auto-login in the Moodle site if available.
     *
     * @param inApp True to open it in InAppBrowser, false to open in browser.
     * @param url The URL to open.
     * @param options Override default options passed to $cordovaInAppBrowser#open.
     * @param alertMessage If defined, an alert will be shown before opening the browser/inappbrowser.
     * @return Promise resolved when done. Resolve param is returned only if inApp=true.
     */
    async openWithAutoLogin(
        inApp: boolean,
        url: string,
        options: InAppBrowserOptions & CoreUtilsOpenInBrowserOptions = {},
        alertMessage?: string,
    ): Promise<InAppBrowserObject | void> {
        // Get the URL to open.
        const autoLoginUrl = await this.getAutoLoginUrl(url);

        if (alertMessage) {
            // Show an alert first.
            const alert = await CoreDomUtils.showAlert(
                Translate.instant('core.notice'),
                alertMessage,
                undefined,
                3000,
            );

            await alert.onDidDismiss();
            options.showBrowserWarning = false; // A warning already shown, no need to show another.
        }

        // Open the URL.
        if (inApp) {
            return CoreUtils.openInApp(autoLoginUrl, options);
        } else {
            options.browserWarningUrl = url;

            return CoreUtils.openInBrowser(autoLoginUrl, options);
        }
    }

    /**
     * Open a URL in browser or InAppBrowser using auto-login in the Moodle site if available and the URL belongs to the site.
     *
     * @param inApp True to open it in InAppBrowser, false to open in browser.
     * @param url The URL to open.
     * @param options Override default options passed to inappbrowser.
     * @param alertMessage If defined, an alert will be shown before opening the browser/inappbrowser.
     * @return Promise resolved when done. Resolve param is returned only if inApp=true.
     * @deprecated since 4.1. Use openWithAutoLogin instead, now it always checks that URL belongs to same site.
     */
    async openWithAutoLoginIfSameSite(
        inApp: boolean,
        url: string,
        options: InAppBrowserOptions & CoreUtilsOpenInBrowserOptions = {},
        alertMessage?: string,
    ): Promise<InAppBrowserObject | void> {
        return this.openWithAutoLogin(inApp, url, options, alertMessage);
    }

    /**
     * Get the config of this site.
     * It is recommended to use getStoredConfig instead since it's faster and doesn't use network.
     *
     * @param name Name of the setting to get. If not set or false, all settings will be returned.
     * @param ignoreCache True if it should ignore cached data.
     * @return Promise resolved with site config.
     */
    getConfig(name?: undefined, ignoreCache?: boolean): Promise<CoreSiteConfig>;
    getConfig(name: string, ignoreCache?: boolean): Promise<string>;
    getConfig(name?: string, ignoreCache?: boolean): Promise<string | CoreSiteConfig> {
        const preSets: CoreSiteWSPreSets = {
            cacheKey: this.getConfigCacheKey(),
        };

        if (ignoreCache) {
            preSets.getFromCache = false;
            preSets.emergencyCache = false;
        }

        return this.read('tool_mobile_get_config', {}, preSets).then((config: CoreSiteConfigResponse) => {
            if (name) {
                // Return the requested setting.
                for (const x in config.settings) {
                    if (config.settings[x].name == name) {
                        return config.settings[x].value;
                    }
                }

                throw new CoreError('Site config not found: ' + name);
            } else {
                // Return all settings in the same array.
                const settings = {};
                config.settings.forEach((setting) => {
                    settings[setting.name] = setting.value;
                });

                return settings;
            }
        });
    }

    /**
     * Invalidates config WS call.
     *
     * @return Promise resolved when the data is invalidated.
     */
    async invalidateConfig(): Promise<void> {
        await this.invalidateWsCacheForKey(this.getConfigCacheKey());
    }

    /**
     * Get cache key for getConfig WS calls.
     *
     * @return Cache key.
     */
    protected getConfigCacheKey(): string {
        return 'tool_mobile_get_config';
    }

    /**
     * Get the stored config of this site.
     *
     * @param name Name of the setting to get. If not set, all settings will be returned.
     * @return Site config or a specific setting.
     */
    getStoredConfig(): CoreSiteConfig | undefined;
    getStoredConfig(name: string): string | undefined;
    getStoredConfig(name?: string): string | CoreSiteConfig | undefined {
        if (!this.config) {
            return;
        }

        if (name) {
            return this.config[name];
        } else {
            return this.config;
        }
    }

    /**
     * Check if a certain feature is disabled in the site.
     *
     * @param name Name of the feature to check.
     * @return Whether it's disabled.
     */
    isFeatureDisabled(name: string): boolean {
        const disabledFeatures = this.getStoredConfig('tool_mobile_disabledfeatures');
        if (!disabledFeatures) {
            return false;
        }

        const regEx = new RegExp('(,|^)' + CoreTextUtils.escapeForRegex(name) + '(,|$)', 'g');

        return !!disabledFeatures.match(regEx);
    }

    /**
     * Calculate if offline is disabled in the site.
     */
    calculateOfflineDisabled(): void {
        this.offlineDisabled = this.isFeatureDisabled('NoDelegate_CoreOffline');
    }

    /**
     * Get whether offline is disabled in the site.
     *
     * @return Whether it's disabled.
     */
    isOfflineDisabled(): boolean {
        return this.offlineDisabled;
    }

    /**
     * Check if the site version is greater than one or several versions.
     * This function accepts a string or an array of strings. If array, the last version must be the highest.
     *
     * @param versions Version or list of versions to check.
     * @return Whether it's greater or equal, false otherwise.
     * @description
     * If a string is supplied (e.g. '3.2.1'), it will check if the site version is greater or equal than this version.
     *
     * If an array of versions is supplied, it will check if the site version is greater or equal than the last version,
     * or if it's higher or equal than any of the other releases supplied but lower than the next major release. The last
     * version of the array must be the highest version.
     * For example, if the values supplied are ['3.0.5', '3.2.3', '3.3.1'] the function will return true if the site version
     * is either:
     *     - Greater or equal than 3.3.1.
     *     - Greater or equal than 3.2.3 but lower than 3.3.
     *     - Greater or equal than 3.0.5 but lower than 3.1.
     *
     * This function only accepts versions from 2.4.0 and above. If any of the versions supplied isn't found, it will assume
     * it's the last released major version.
     */
    isVersionGreaterEqualThan(versions: string | string[]): boolean {
        const info = this.getInfo();

        if (!info || !info.version) {
            return false;
        }

        const siteVersion = Number(info.version);

        if (Array.isArray(versions)) {
            if (!versions.length) {
                return false;
            }

            for (let i = 0; i < versions.length; i++) {
                const versionNumber = this.getVersionNumber(versions[i]);
                if (i == versions.length - 1) {
                    // It's the last version, check only if site version is greater than this one.
                    return siteVersion >= versionNumber;
                } else {
                    // Check if site version if bigger than this number but lesser than next major.
                    if (siteVersion >= versionNumber && siteVersion < this.getNextMajorVersionNumber(versions[i])) {
                        return true;
                    }
                }
            }
        } else if (typeof versions == 'string') {
            // Compare with this version.
            return siteVersion >= this.getVersionNumber(versions);
        }

        return false;
    }

    /**
     * Given a URL, convert it to a URL that will auto-login if supported.
     *
     * @param url The URL to convert.
     * @param showModal Whether to show a loading modal.
     * @return Promise resolved with the converted URL.
     */
    async getAutoLoginUrl(url: string, showModal: boolean = true): Promise<string> {
        if (!this.privateToken) {
            // No private token, don't change the URL.
            return url;
        }

        if (!this.containsUrl(url)) {
            // URL doesn't belong to the site, don't auto login.
            return url;
        }

        if (this.lastAutoLogin > 0) {
            const timeBetweenRequests = await CoreUtils.ignoreErrors(
                this.getConfig('tool_mobile_autologinmintimebetweenreq'),
                CoreConstants.SECONDS_MINUTE * 6,
            );

            if (CoreTimeUtils.timestamp() - this.lastAutoLogin < timeBetweenRequests) {
                // Not enough time has passed since last auto login.
                return url;
            }
        }

        const userId = this.getUserId();
        const params = {
            privatetoken: this.privateToken,
        };
        let modal: CoreIonLoadingElement | undefined;

        if (showModal) {
            modal = await CoreDomUtils.showModalLoading();
        }

        try {
            // Use write to not use cache.
            const data = await this.write<CoreSiteAutologinKeyResult>('tool_mobile_get_autologin_key', params);

            if (!data.autologinurl || !data.key) {
                // Not valid data, return the same URL.
                return url;
            }

            this.lastAutoLogin = CoreTimeUtils.timestamp();

            return data.autologinurl + '?userid=' + userId + '&key=' + data.key + '&urltogo=' + encodeURIComponent(url);
        } catch (error) {
            // Couldn't get autologin key, return the same URL.
            return url;
        } finally {
            modal?.dismiss();
        }
    }

    /**
     * Get a version number from a release version.
     * If release version is valid but not found in the list of Moodle releases, it will use the last released major version.
     *
     * @param version Release version to convert to version number.
     * @return Version number, 0 if invalid.
     */
    protected getVersionNumber(version: string): number {
        const data = this.getMajorAndMinor(version);

        if (!data) {
            // Invalid version.
            return 0;
        }

        if (CoreSite.MOODLE_RELEASES[data.major] === undefined) {
            // Major version not found. Use the last one.
            const major = Object.keys(CoreSite.MOODLE_RELEASES).pop();
            if (!major) {
                return 0;
            }

            data.major = major;
        }

        return CoreSite.MOODLE_RELEASES[data.major] + data.minor;
    }

    /**
     * Given a release version, return the major and minor versions.
     *
     * @param version Release version (e.g. '3.1.0').
     * @return Object with major and minor. Returns false if invalid version.
     */
    protected getMajorAndMinor(version: string): {major: string; minor: number} | false {
        const match = version.match(/^(\d+)(\.(\d+)(\.\d+)?)?/);
        if (!match || !match[1]) {
            // Invalid version.
            return false;
        }

        return {
            major: match[1] + '.' + (match[3] || '0'),
            minor: parseInt(match[5], 10) || 0,
        };
    }

    /**
     * Given a release version, return the next major version number.
     *
     * @param version Release version (e.g. '3.1.0').
     * @return Next major version number.
     */
    protected getNextMajorVersionNumber(version: string): number {
        const data = this.getMajorAndMinor(version);
        const releases = Object.keys(CoreSite.MOODLE_RELEASES);

        if (!data) {
            // Invalid version.
            return 0;
        }

        const position = releases.indexOf(data.major);

        if (position == -1 || position == releases.length - 1) {
            // Major version not found or it's the last one. Use the last one.
            return CoreSite.MOODLE_RELEASES[releases[position]];
        }

        return CoreSite.MOODLE_RELEASES[releases[position + 1]];
    }

    /**
     * Deletes a site setting.
     *
     * @param name The config name.
     * @return Promise resolved when done.
     */
    async deleteSiteConfig(name: string): Promise<void> {
        await this.configTable.deleteByPrimaryKey({ name });
    }

    /**
     * Get a site setting on local device.
     *
     * @param name The config name.
     * @param defaultValue Default value to use if the entry is not found.
     * @return Resolves upon success along with the config data. Reject on failure.
     */
    async getLocalSiteConfig<T extends number | string>(name: string, defaultValue?: T): Promise<T> {
        try {
            const entry = await this.configTable.getOneByPrimaryKey({ name });

            return <T> entry.value;
        } catch (error) {
            if (defaultValue !== undefined) {
                return defaultValue;
            }

            throw error;
        }
    }

    /**
     * Set a site setting on local device.
     *
     * @param name The config name.
     * @param value The config value. Can only store number or strings.
     * @return Promise resolved when done.
     */
    async setLocalSiteConfig(name: string, value: number | string): Promise<void> {
        await this.configTable.insert({ name, value });
    }

    /**
     * Get a certain cache expiration delay.
     *
     * @param updateFrequency The update frequency of the entry.
     * @return Expiration delay.
     */
    getExpirationDelay(updateFrequency?: number): number {
        updateFrequency = updateFrequency || CoreSite.FREQUENCY_USUALLY;
        let expirationDelay = this.UPDATE_FREQUENCIES[updateFrequency] || this.UPDATE_FREQUENCIES[CoreSite.FREQUENCY_USUALLY];

        if (CoreNetwork.isNetworkAccessLimited()) {
            // Not WiFi, increase the expiration delay a 50% to decrease the data usage in this case.
            expirationDelay *= 1.5;
        }

        return expirationDelay;
    }

    /*
     * Check if tokenpluginfile script works in the site.
     *
     * @param url URL to check.
     * @return Promise resolved with boolean: whether it works or not.
     */
    checkTokenPluginFile(url: string): Promise<boolean> {
        if (!CoreUrlUtils.canUseTokenPluginFile(url, this.siteUrl, this.infos && this.infos.userprivateaccesskey)) {
            // Cannot use tokenpluginfile.
            return Promise.resolve(false);
        } else if (this.tokenPluginFileWorks !== undefined) {
            // Already checked.
            return Promise.resolve(this.tokenPluginFileWorks);
        } else if (this.tokenPluginFileWorksPromise) {
            // Check ongoing, use the same promise.
            return this.tokenPluginFileWorksPromise;
        } else if (!CoreNetwork.isOnline()) {
            // Not online, cannot check it. Assume it's working, but don't save the result.
            return Promise.resolve(true);
        }

        url = this.fixPluginfileURL(url);

        this.tokenPluginFileWorksPromise = CoreWS.urlWorks(url).then((result) => {
            this.tokenPluginFileWorks = result;

            return result;
        });

        return this.tokenPluginFileWorksPromise;
    }

    /**
     * Check if a URL to a file belongs to the site and uses the pluginfileurl or tokenpluginfileurl endpoints.
     *
     * @param url File URL to check.
     * @return Whether it's a site file URL.
     */
    isSitePluginFileUrl(url: string): boolean {
        const isPluginFileUrl = CoreUrlUtils.isPluginFileUrl(url) || CoreUrlUtils.isTokenPluginFileUrl(url);
        if (!isPluginFileUrl) {
            return false;
        }

        return this.containsUrl(url);
    }

    /**
     * Check if a URL to a file belongs to the site and is a theme image file.
     *
     * @param url File URL to check.
     * @return Whether it's a site theme image URL.
     */
    isSiteThemeImageUrl(url: string): boolean {
        if (!CoreUrlUtils.isThemeImageUrl(url)) {
            return false;
        }

        return this.containsUrl(url);
    }

    /**
     * Deletes last viewed records based on some conditions.
     *
     * @param conditions Conditions.
     * @return Promise resolved when done.
     */
    async deleteLastViewed(conditions?: Partial<CoreSiteLastViewedDBRecord>): Promise<void> {
        await this.lastViewedTable.delete(conditions);
    }

    /**
     * Get a last viewed record for a component+id.
     *
     * @param component The component.
     * @param id ID.
     * @return Resolves with last viewed record, undefined if not found.
     */
    async getLastViewed(component: string, id: number): Promise<CoreSiteLastViewedDBRecord | undefined> {
        try {
            return await this.lastViewedTable.getOneByPrimaryKey({ component, id });
        } catch (error) {
            // Not found.
        }
    }

    /**
     * Get several last viewed for a certain component.
     *
     * @param component The component.
     * @param ids IDs. If not provided or empty, return all last viewed for a component.
     * @return Resolves with last viewed records, undefined if error.
     */
    async getComponentLastViewed(component: string, ids: number[] = []): Promise<CoreSiteLastViewedDBRecord[] | undefined> {
        try {
            if (!ids.length) {
                return await this.lastViewedTable.getMany({ component });
            }

            const whereAndParams = SQLiteDB.getInOrEqual(ids);

            whereAndParams.sql = 'id ' + whereAndParams.sql + ' AND component = ?';
            whereAndParams.params.push(component);

            return await this.lastViewedTable.getManyWhere({
                sql: whereAndParams.sql,
                sqlParams: whereAndParams.params,
                js: (record) => record.component === component && ids.includes(record.id),
            });
        } catch (error) {
            // Not found.
        }
    }

    /**
     * Store a last viewed record.
     *
     * @param component The component.
     * @param id ID.
     * @param value Last viewed item value.
     * @param options Options.
     * @return Promise resolved when done.
     */
    async storeLastViewed(
        component: string,
        id: number,
        value: string | number,
        options: CoreSiteStoreLastViewedOptions = {},
    ): Promise<void> {
        await this.lastViewedTable.insert({
            component,
            id,
            value: String(value),
            data: options.data,
            timeaccess: options.timeaccess ?? Date.now(),
        });
    }

}

/**
 * PreSets accepted by the WS call.
 */
export type CoreSiteWSPreSets = {
    /**
     * Get the value from the cache if it's still valid.
     */
    getFromCache?: boolean;

    /**
     * Save the result to the cache.
     */
    saveToCache?: boolean;

    /**
     * Ignore cache expiration.
     */
    omitExpires?: boolean;

    /**
     * Use the cache when a request fails. Defaults to true.
     */
    emergencyCache?: boolean;

    /**
     * If true, the app won't call the WS. If the data isn't cached, the call will fail.
     */
    forceOffline?: boolean;

    /**
     * Extra key to add to the cache when storing this call, to identify the entry.
     */
    cacheKey?: string;

    /**
     * Whether it should use cache key to retrieve the cached data instead of the request params.
     */
    getCacheUsingCacheKey?: boolean;

    /**
     * Same as getCacheUsingCacheKey, but for emergency cache.
     */
    getEmergencyCacheUsingCacheKey?: boolean;

    /**
     * If true, the cache entry will be deleted if the WS call returns an exception.
     */
    deleteCacheIfWSError?: boolean;

    /**
     * Whether it should only be 1 entry for this cache key (all entries with same key will be deleted).
     */
    uniqueCacheKey?: boolean;

    /**
     * Whether to filter WS response (moodlewssettingfilter). Defaults to true.
     */
    filter?: boolean;

    /**
     * Whether to rewrite URLs (moodlewssettingfileurl). Defaults to true.
     */
    rewriteurls?: boolean;

    /**
     * Language to send to the WebService (moodlewssettinglang). Defaults to app's language.
     */
    lang?: string;

    /**
     * Defaults to true. Set to false when the expected response is null.
     */
    responseExpected?: boolean;

    /**
     * Defaults to 'object'. Use it when you expect a type that's not an object|array.
     */
    typeExpected?: string;

    /**
     * Wehther a pending request in the queue matching the same function and arguments can be reused instead of adding
     * a new request to the queue. Defaults to true for read requests.
     */
    reusePending?: boolean;

    /**
     * Whether the request will be be sent immediately as a single request. Defaults to false.
     */
    skipQueue?: boolean;

    /**
     * Cache the response if it returns an errorcode present in this list.
     */
    cacheErrors?: string[];

    /**
     * Update frequency. This value determines how often the cached data will be updated. Possible values:
     * CoreSite.FREQUENCY_USUALLY, CoreSite.FREQUENCY_OFTEN, CoreSite.FREQUENCY_SOMETIMES, CoreSite.FREQUENCY_RARELY.
     * Defaults to CoreSite.FREQUENCY_USUALLY.
     */
    updateFrequency?: number;

    /**
     * Component name. Optionally included if this request is being made on behalf of a specific
     * component (e.g. activity).
     */
    component?: string;

    /**
     * Component id. Optionally included when 'component' is set.
     */
    componentId?: number;

    /**
     * Whether to split a request if it has too many parameters. Sending too many parameters to the site
     * can cause the request to fail (see PHP's max_input_vars).
     */
    splitRequest?: CoreWSPreSetsSplitRequest;
};

/**
 * Response of checking local_mobile status.
 *
 * @deprecated since app 4.0
 */
export type LocalMobileResponse = {
    /**
     * Code to identify the authentication method to use.
     */
    code: number;

    /**
     * Name of the service to use.
     */
    service?: string;

    /**
     * Code of the warning message.
     */
    warning?: string;

    /**
     * Whether core SSO is supported.
     */
    coreSupported?: boolean;
};

/**
 * Info of a request waiting in the queue.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RequestQueueItem<T = any> = {
    cacheId: string;
    method: string;
    data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    preSets: CoreSiteWSPreSets;
    wsPreSets: CoreWSPreSets;
    deferred: CorePromisedValue<T>;
};

/**
 * Result of WS core_webservice_get_site_info.
 */
export type CoreSiteInfoResponse = {
    sitename: string; // Site name.
    username: string; // Username.
    firstname: string; // First name.
    lastname: string; // Last name.
    fullname: string; // User full name.
    lang: string; // Current language.
    userid: number; // User id.
    siteurl: string; // Site url.
    userpictureurl: string; // The user profile picture.
    functions: {
        name: string; // Function name.
        version: string; // The version number of the component to which the function belongs.
    }[];
    downloadfiles?: number; // 1 if users are allowed to download files, 0 if not.
    uploadfiles?: number; // 1 if users are allowed to upload files, 0 if not.
    release?: string; // Moodle release number.
    version?: string; // Moodle version number.
    mobilecssurl?: string; // Mobile custom CSS theme.
    advancedfeatures?: { // Advanced features availability.
        name: string; // Feature name.
        value: number; // Feature value. Usually 1 means enabled.
    }[];
    usercanmanageownfiles?: boolean; // True if the user can manage his own files.
    userquota?: number; // User quota (bytes). 0 means user can ignore the quota.
    usermaxuploadfilesize?: number; // User max upload file size (bytes). -1 means the user can ignore the upload file size.
    userhomepage?: CoreSiteInfoUserHomepage; // The default home page for the user.
    userprivateaccesskey?: string; // Private user access key for fetching files.
    siteid?: number; // Site course ID.
    sitecalendartype?: string; // Calendar type set in the site.
    usercalendartype?: string; // Calendar typed used by the user.
    userissiteadmin?: boolean; // Whether the user is a site admin or not.
    theme?: string; // Current theme for the user.
};

/**
 * Site info, including some calculated data.
 */
export type CoreSiteInfo = CoreSiteInfoResponse & {
    functionsByName?: {
        [name: string]: {
            name: string; // Function name.
            version: string; // The version number of the component to which the function belongs.
        };
    };
};

/**
 * Enum constants that define default user home page.
 */
export enum CoreSiteInfoUserHomepage {
    HOMEPAGE_SITE = 0, // Site home.
    HOMEPAGE_MY = 1, // Dashboard.
    HOMEPAGE_MYCOURSES = 3, // My courses.
};

/**
 * Result of WS tool_mobile_get_config.
 */
export type CoreSiteConfigResponse = {
    settings: { // Settings.
        name: string; // The name of the setting.
        value: string; // The value of the setting.
    }[];
    warnings?: CoreWSExternalWarning[];
};

/**
 * Site config indexed by name.
 */
export type CoreSiteConfig = {[name: string]: string};

/**
 * Result of WS tool_mobile_get_public_config.
 */
export type CoreSitePublicConfigResponse = {
    wwwroot: string; // Site URL.
    httpswwwroot: string; // Site https URL (if httpslogin is enabled).
    sitename: string; // Site name.
    guestlogin: number; // Whether guest login is enabled.
    rememberusername: number; // Values: 0 for No, 1 for Yes, 2 for optional.
    authloginviaemail: number; // Whether log in via email is enabled.
    registerauth: string; // Authentication method for user registration.
    forgottenpasswordurl: string; // Forgotten password URL.
    authinstructions: string; // Authentication instructions.
    authnoneenabled: number; // Whether auth none is enabled.
    enablewebservices: number; // Whether Web Services are enabled.
    enablemobilewebservice: number; // Whether the Mobile service is enabled.
    maintenanceenabled: number; // Whether site maintenance is enabled.
    maintenancemessage: string; // Maintenance message.
    logourl?: string; // The site logo URL.
    compactlogourl?: string; // The site compact logo URL.
    typeoflogin: number; // The type of login. 1 for app, 2 for browser, 3 for embedded.
    launchurl?: string; // SSO login launch URL.
    mobilecssurl?: string; // Mobile custom CSS theme.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    tool_mobile_disabledfeatures?: string; // Disabled features in the app.
    identityproviders?: CoreSiteIdentityProvider[]; // Identity providers.
    country?: string; // Default site country.
    agedigitalconsentverification?: boolean; // Whether age digital consent verification is enabled.
    supportname?: string; // Site support contact name (only if age verification is enabled).
    supportemail?: string; // Site support contact email (only if age verification is enabled).
    autolang?: number; // Whether to detect default language from browser setting.
    lang?: string; // Default language for the site.
    langmenu?: number; // Whether the language menu should be displayed.
    langlist?: string; // Languages on language menu.
    locale?: string; // Sitewide locale.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    tool_mobile_minimumversion?: string; // Minimum required version to access.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    tool_mobile_iosappid?: string; // IOS app's unique identifier.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    tool_mobile_androidappid?: string; // Android app's unique identifier.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    tool_mobile_setuplink?: string; // App download page.
    tool_mobile_qrcodetype?: CoreSiteQRCodeType; // eslint-disable-line @typescript-eslint/naming-convention
    warnings?: CoreWSExternalWarning[];
};

/**
 * Identity provider.
 */
export type CoreSiteIdentityProvider = {
    name: string; // The identity provider name.
    iconurl: string; // The icon URL for the provider.
    url: string; // The URL of the provider.
};

/**
 * Result of WS tool_mobile_get_autologin_key.
 */
export type CoreSiteAutologinKeyResult = {
    key: string; // Auto-login key for a single usage with time expiration.
    autologinurl: string; // Auto-login URL.
    warnings?: CoreWSExternalWarning[];
};

/**
 * Result of WS tool_mobile_call_external_functions.
 */
export type CoreSiteCallExternalFunctionsResult = {
    responses: {
        error: boolean; // Whether an exception was thrown.
        data?: string; // JSON-encoded response data.
        exception?: string; // JSON-encoed exception info.
    }[];
};

/**
 * Options for storeLastViewed.
 */
export type CoreSiteStoreLastViewedOptions = {
    data?: string; // Other data.
    timeaccess?: number; // Accessed time. If not set, current time.
};
