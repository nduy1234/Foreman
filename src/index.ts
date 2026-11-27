// Every handler referenced from manifest.yml is exported here.
export { handler as resolver } from './resolvers';
export { handler as jobsConsumer } from './consumers/jobs';
export { lifecycle, monitorHourly, digestDaily, issueEvents } from './triggers';
export { getProjectRisks, reviewPlanAgainstCode, createInspectionReport, proposeResolution, requestApproval, approvePending } from './actions';
export { onConnectionChange } from './services/twg/connector';
/** graph:connector validateConnection: the demo portal needs no credentials. */
export const validatePortalConnection = async () => ({ success: true });
