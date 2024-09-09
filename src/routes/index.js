'use strict'

module.exports = async function (fastify, opts) {

    /**
     * Queries for and then returns all Accounts in the invoking org.
     *
     * If an org reference is set on SALESFORCE_ORG_NAME config var,
     * obtain the org's connection from the Heroku Integration add-on
     * and query Accounts in the target org.
     *
     * @param request
     * @param reply
     * @returns {Promise<void>}
     */
    fastify.get('/accounts', async function (request, reply) {
        const { event, context, logger } = request.sdk;

        logger.info(`GET /accounts: ${JSON.stringify(event.data || {})}`);

        if (process.env.SALESFORCE_ORG_NAME) {
            // If an org reference is set, query Accounts in that org
            const orgName = process.env.SALESFORCE_ORG_NAME;
            const herokuIntegrationAddon = request.sdk.addons.herokuIntegration;

            logger.info(`Getting ${orgName} org connection from Heroku Integration add-on...`);
            const anotherOrg = await herokuIntegrationAddon.getConnection(orgName);

            logger.info(`Querying org ${JSON.stringify(anotherOrg)} Accounts...`);
            try {
                const result = await anotherOrg.dataApi.query('SELECT Id, Name FROM Account');
                const accounts = result.records.map(rec => rec.fields);
                logger.info(`For org ${anotherOrg.id}, found the ${accounts.length} Accounts`);
            } catch (e) {
                logger.error(e.message);
            }
        }

        // Query invoking org's Accounts
        const org = context.org;
        logger.info(`Querying org ${org.id} Accounts...`);
        const result = await org.dataApi.query('SELECT Id, Name FROM Account');
        const accounts = result.records.map(rec => rec.fields);
        logger.info(`For org ${org.id}, found the following Accounts: ${JSON.stringify(accounts || {})}`);
        return accounts;
    });

    // Custom handler for async /unitofwork API that synchronously responds to request
    const unitOfWorkResponseHandler = async (request, reply) => {
        reply.code(201).send({'Code201': 'Received!', responseCode: 201});
    }

   /**
    * Asynchronous API that interacts with invoking org via External Service
    * callbacks defined in the OpenAPI spec.
    *
    * The API receives a payload containing Account, Contact, and Case
    * details and uses the unit of work pattern to assign the corresponding
    * values to its Record while maintaining the relationships. It then
    * commits the Unit of Work and returns the Record Id's for each object.
    *
    * The SDKs unit of work API is wrapped around Salesforce's Composite Graph API.
    * For more information on Composite Graph API, see:
    * https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_graph_introduction.htm
    *
    * The unitofworkResponseHandler function provides custom handling to sync'ly respond to the request.
    */
    fastify.post('/unitofwork',
        // async=true to apply standard response 201 response or provide custom response handler function
        {config: {salesforce: {async: unitOfWorkResponseHandler}}},
        async (request, reply) => {
            const { event, context, logger } = request.sdk;
            const org = context.org;
            const dataApi = context.org.dataApi;

            logger.info(`POST /unitofwork ${JSON.stringify(event.data || {})}`);

            const validateField = (field, value) => {
                if (!value) throw new Error(`Please provide ${field}`);
            }

            // Validate Input
            const data = event.data;
            validateField('accountName', data.accountName);
            validateField('lastName', data.lastName);
            validateField('subject', data.subject);

            // Create a unit of work that inserts multiple objects.
            const uow = dataApi.newUnitOfWork();

            // Register a new Account for Creation
            const accountId = uow.registerCreate({
                type: 'Account',
                fields: {
                    Name: data.accountName
                }
            });

            // Register a new Contact for Creation
            const contactId = uow.registerCreate({
                type: 'Contact',
                fields: {
                    FirstName: data.firstName,
                    LastName: data.lastName,
                    AccountId: accountId // Get the ReferenceId from previous operation
                }
            });

            // Register a new Case for Creation
            const serviceCaseId = uow.registerCreate({
                type: 'Case',
                fields: {
                    Subject: data.subject,
                    Description: data.description,
                    Origin: 'Web',
                    Status: 'New',
                    AccountId: accountId, // Get the ReferenceId from previous operation
                    ContactId: contactId // Get the ReferenceId from previous operation
                }
            });

            // Register a follow-up Case for Creation
            const followupCaseId = uow.registerCreate({
                type: 'Case',
                fields: {
                    ParentId: serviceCaseId, // Get the ReferenceId from previous operation
                    Subject: 'Follow Up',
                    Description: 'Follow up with Customer',
                    Origin: 'Web',
                    Status: 'New',
                    AccountId: accountId, // Get the ReferenceId from previous operation
                    ContactId: contactId // Get the ReferenceId from previous operation
                }
            });

            try {
                // Commit the Unit of Work with all the previous registered operations
                const response = await dataApi.commitUnitOfWork(uow);

                // Construct the result by getting the Id from the successful inserts
                const callbackResponseBody = {
                    accountId: response.get(accountId).id,
                    contactId: response.get(contactId).id,
                    cases: {
                        serviceCaseId: response.get(serviceCaseId).id,
                        followupCaseId: response.get(followupCaseId).id
                    }
                };

                const opts = {
                    method: 'POST',
                    body: JSON.stringify(callbackResponseBody),
                    headers: {'Content-Type': 'application/json'}
                }
                const callbackResponse = await org.request(data.callbackUrl, opts);
                logger.info(JSON.stringify(callbackResponse));
            } catch (err) {
                const errorMessage = `Failed to insert record. Root Cause : ${err.message}`;
                logger.error(errorMessage);
                throw new Error(errorMessage);
            }

            return reply;
    });

    /**
     * Handle Data Cloud data change event invoke as a Data Action Target
     * webhook.
     *
     * If a Data Cloud org reference is set on DATA_CLOUD_ORG config var
     * and a query string set on DATA_CLOUD_QUERY config var, obtain the
     * org's connection from the Heroku Integration add-on and query the
     * target org.
     *
     * API not included in api-spec.yaml as it is not invoked by a
     * Data Cloud Data Action Target webhook and not an External Service.
     *
     * For more information on Data Cloud data change event, see:
     * https://help.salesforce.com/s/articleView?id=sf.c360_a_data_action_target_in_customer_data_platform.htm&type=5
     */
    fastify.post('/handleDataCloudDataChangeEvent',
        {config: {salesforce: {parseRequest: false}}}, // Parsing is specific to External Service requests
        async function (request, reply) {
            const logger = request.log;
            const dataCloud = request.sdk.dataCloud;

            // REMOVE ME:
            logger.info(`x-signature: ${request.headers['x-signature']}`);

            if (!request.body) {
                logger.warn('Empty body, no events found');
                return reply.code(400).send();
            }

            const actionEvent = dataCloud.parseDataActionEvent(request.body);
            logger.info(`POST /dataCloudDataChangeEvent: ${actionEvent.count} events for schemas ${Array.isArray(actionEvent.schemas) && actionEvent.schemas.length > 0 ? (actionEvent.schemas.map((s) => s.schemaId)).join() : 'n/a'}`);

            // Loop thru event data
            actionEvent.events.forEach(evt => {
                logger.info(`Got action '${evt.ActionDeveloperName}', event type '${evt.EventType}' triggered by ${evt.EventPrompt} on object '${evt.SourceObjectDeveloperName}' published on ${evt.EventPublishDateTime}`);
                // Handle changed object values via evt.PayloadCurrentValue
            });

            // If config vars are set, query Data Cloud org
            if (process.env.DATA_CLOUD_ORG && process.env.DATA_CLOUD_QUERY) {
                const orgName = process.env.DATA_CLOUD_ORG;
                const query = process.env.DATA_CLOUD_QUERY;
                const herokuIntegrationAddon = request.sdk.addons.herokuIntegration;

                // Get DataCloud org connection from add-on
                logger.info(`Getting '${orgName}' org connection from Heroku Integration add-on...`);
                const org = await herokuIntegrationAddon.getConnection(orgName);

                // Query DataCloud org
                logger.info(`Querying org ${org.id}: ${query}`);
                const response = await org.dataCloudApi.query(query);
                logger.info(`Query response: ${JSON.stringify(response.data || {})}`);
            }

            reply.code(201).send();
    });

    fastify.setErrorHandler(function (error, request, reply) {
        request.log.error(error)
        reply.status(500).send({ code: '500', message: error.message });
    });

/*pdfgenerator: Function that leverages puppeteer mainly for headless browser PDF generation
 *
 * The exported method is the entry point for your code when the function is invoked.
 *
 * Following parameters are pre-configured and provided to your function on execution:
 * @param event: represents the data associated with the occurrence of an event, and
 *                 supporting metadata about the source of that occurrence.
 * @param context: represents the connection to Functions and your Salesforce org.
 * @param logger: logging handler used to capture application logs and trace specifically
 *                 to a given execution of a function.
 *
 * * Reference: https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagegotourl-options
 * Default  payload if nothing provided
 *
 * 	{
 * 		"filename" : "",
 * 		"recordId" : "",
 *		"path" : "https://www.google.com", REQUIRED
 *		"pageFormat" : "Letter",
 *		"headless" : true,
 *		"puppeteerProduct" : "chrome",
 *		"revisionInfo" : "",
 *		"incognito" : false,
 * 		"emulateMediaType" : "print",
 *		"width" : "",
 *		"height" : "",
 *		"margin" : "",
 *		"scale" : 0,
 *		"displayHeaderFooter" : false,
 *		"headerTemplate" : <HTML string>,
 * 		"footerTemplate" : <HTML string>,
 * 		"printBackground" : false,
 * 		"landscape" : false,
 * 		"pageRanges" : ""
 *	}
 *
 * scale <number> Scale of the webpage rendering. Defaults to 1. Scale amount must be between 0.1 and 2. *
 *
 * The width, height, and margin options accept values labeled with units. Unlabeled values are treated as pixels.
 * All possible units are:
 *
 *		px - pixel
 *		in - inch
 *		cm - centimeter
 *		mm - millimeter
 *
 * Paper format. If set, takes priority over width or height options. Defaults to 'Letter'.
 * The pageFormat options are:
 *
 * 		Letter: 8.5in x 11in (default)
 * 		Legal: 8.5in x 14in
 * 		Tabloid: 11in x 17in
 * 		Ledger: 17in x 11in
 * 		A0: 33.1in x 46.8in
 * 		A1: 23.4in x 33.1in
 * 		A2: 16.54in x 23.4in
 * 		A3: 11.7in x 16.54in
 * 		A4: 8.27in x 11.7in
 * 		A5: 5.83in x 8.27in
 * 		A6: 4.13in x 5.83in
 *
 * The emulateMediaType options are:
 *
 * 		print (default)
 * 		screen
 * 		blank
 *
 * The waitUntil options are:
 *
 *		load
 *		domcontentloaded
 *		networkidle0
 *		networkidle2
 *
 */
 fastify.post('/generate-pdf',
    // async=true to apply standard response 201 response or provide custom response handler function
    {config: {salesforce: {async: unitOfWorkResponseHandler}}},
    async (request, reply) => {
        const { event, context, logger } = request.sdk;
        const org = context.org;
        const dataApi = context.org.dataApi;

        logger.info(`POST /generatePDF ${JSON.stringify(event.data || {})}`);
        
      // Init printout
	logger.info(
		`Invoking Simplegenpdf with payload ${JSON.stringify(event.data || {})}`
	);


	/* 
    * 
    * Variable initialization based on payload 
    * 
    */
	const { baseUrl, apiVersion } = context.org;
	const accessToken = context.org.dataApi.accessToken;
	const isHeadless = event.data.headless === false ? false : true; // Default true
	const puppeteerProduct = event.data.puppeteerProduct
		? event.data.puppeteerProduct
		: "chrome"; // Default chrome
	const revisionInfo = event.data.revisionInfo ? event.data.revisionInfo : ""; // Default based on product selected
	const incognito = event.data.incognito ? event.data.incognito : false; // Default false

	const path = event.data.path ? event.data.path : "";
	const pageFormat = event.data.pageFormat ? event.data.pageFormat : "Letter";
	const emulateMediaType = event.data.emulateMediaType
		? event.data.emulateMediaType
		: "";
	const waitUntil = event.data.waitUntil
		? event.data.waitUntil
		: "networkidle2"; // Default networkidle2
	const doAutoScroll = event.data.autoScroll ? true : false;
	const fitWindow = event.data.fitWindow ? true : false;
	const mobile = event.data.mobile ? true : false;

	if (isHeadless && !path) {
		return `Missing path parameter. REQUIRED`;
	}

	const scale = event.data.scale ? event.data.scale : 1;
	const width = event.data.width ? event.data.width : "";
	const height = event.data.height ? event.data.height : "";
	const margin = event.data.margin ? event.data.margin : 0;
	const preferCSSPageSize = event.data.preferCSSPageSize ? true : false;

	const displayHeaderFooter = event.data.displayHeaderFooter
		? event.data.displayHeaderFooter
		: false;
	let headerTemplate;
	let footerTemplate;
	if (displayHeaderFooter) {
		headerTemplate = event.data.headerTemplate
			? event.data.headerTemplate
			: "";
		footerTemplate = event.data.footerTemplate
			? event.data.footerTemplate
			: "";
	}
	const printBackground = event.data.printBackground
		? event.data.printBackground
		: false;
	const landscape = event.data.landscape ? event.data.landscape : false;
	const pageRanges = event.data.pageRanges ? event.data.pageRanges : "";
	const filename = event.data.filename + ".pdf";
	const recordId = event.data.recordId;
    if (!recordId) {
		throw new Error(`Missing "recordId" parameter. REQUIRED`);
	}
	// ***********************************************************************

	let browserFetcher;
	let revInfo;
	if (revisionInfo) {
		browserFetcher = puppeteer.createBrowserFetcher();
		revInfo = await browserFetcher.download(revisionInfo);
	}

	// Main function genPuppeteerPDF definition
	async function genPuppeteerPDF() {
		// Basic options
		let options = {
			headless: isHeadless,
			ignoreHTTPSErrors: true,
			product: puppeteerProduct, //chromium or firefox
			args: ["--no-sandbox", "--disable-setuid-sandbox"]
		};

		// Custom revision (chromium or firefox) ?
		if (revInfo) {
			options.executablePath = revisionInfo.executablePath;
		}

		// Open Browser
		const browser = await puppeteer.launch(options);

		// Incognito context ?
		let pContext;
		let page;
		if (incognito) {
			pContext = await browser.createIncognitoBrowserContext();
			page = await pContext.newPage();
			await page.setViewport({
				width: 1920, height: 1080,  deviceScaleFactor: 1, mobile: false, waitLoad: true,
				waitNetworkIdle: true
			});
		} else {
			// Normal browser context
			page = await browser.newPage();
		}

		// Format page
		if(!pageFormat){
			await page.setViewport({
				width: width,
				height: height,
				deviceScaleFactor: scale,
				fitWindow: fitWindow,
				mobile: mobile,
				waitLoad: true,
				waitNetworkIdle: true
			});
		}		

		// Set media type
		if (emulateMediaType) {
			if (emulateMediaType === "blank") {
				emulateMediaType = null;
			}
			await page.emulateMediaType(emulateMediaType);
		}

		// Set option for Headless
		let pageResult;
		// page.pdf() is currently supported only in headless mode.
		// @see https://bugs.chromium.org/p/chromium/issues/detail?id=753118
		let pdfOpts = {};
		pdfOpts.path = filename;
		if (pageFormat) pdfOpts.format = pageFormat;
		if (scale !== 1) pdfOpts.scale = scale;
		if (width) pdfOpts.width = width;
		if (height) pdfOpts.height = height;
		if (margin) pdfOpts.margin = margin;
		if (displayHeaderFooter) {
			pdfOpts.displayHeaderFooter = true;
			pdfOpts.headerTemplate = headerTemplate;
			pdfOpts.footerTemplate = footerTemplate;
		}
		if (printBackground) pdfOpts.printBackground = true;
		if (landscape) pdfOpts.landscape = true;
		if (pageRanges) pdfOpts.pageRanges = pageRanges;
		if(preferCSSPageSize) pdfOpts.preferCSSPageSize = true;

		// LOG START
		let startTime = new Date();
		logger.info(
			`Diff startTime = ${startTime}`
		);

		// Open page		
		await page.goto(path, {
			waitUntil: waitUntil
		});

		// Scroll if required
		if (doAutoScroll){
			await autoScroll(page);
		}

		// Generate PDF Buffer
		pageResult = await page.pdf(pdfOpts);

		// LOG END
		let endTime = new Date();
		logger.info(
			`Diff endTime = ${endTime}`
		);

		// LOG CALC DIFF
		let diffTime = endTime - startTime;
		logger.info(
			`Diff PUPPETEER time in 200 generation = ${diffTime}`
		);

		// Prepare file Upload
		let entityContent = {
			ReasonForChange: "New PDF version",
			PathOnClient: filename,
			FirstPublishLocationId: recordId
		};

		// Api endpoint
		const url = `${baseUrl}/services/data/v${apiVersion}/sobjects/ContentVersion/`;

		// Upload Request
		await request.post({
			url: url,
			auth: {
				bearer: accessToken
			},
			formData: {
				entity_content: {
					value: JSON.stringify(entityContent),
					options: {
						contentType: "application/json"
					}
				},
				VersionData: {
					value: pageResult,
					options: {
						filename: filename,
						contentType: "application/pdf"
					}
				}
			}
		});

		// Close browser
		await browser.close();

		// Capture function END timestamp
		const invokationEnd = new Date();

		// Return results
		return { Message: "Puppeteer File Generated", pdfGenerationTime: endTime - startTime, pdfGenStartTime: startTime, pdfGenEndTime: endTime, invokationTime: invokationEnd - invokationStart, invokationStart: invokationStart, invokationEnd: invokationEnd };
	}

	// Method to ensure scroll and image load takes place 
	async function autoScroll(page) {
		await page.evaluate(async () => {
			await new Promise((resolve, reject) => {
				var totalHeight = 0;
				var distance = 100;
				var timer = setInterval(() => {
					var scrollHeight = document.body.scrollHeight;
					window.scrollBy(0, distance);
					totalHeight += distance;

					if (totalHeight >= scrollHeight - window.innerHeight) {
						clearInterval(timer);
						resolve();
					}
				}, 100);
			});
		});
	}

	let data = genPuppeteerPDF();
	return data;
});

        


}
