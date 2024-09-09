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
}
