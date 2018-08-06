
const ApiGatewayCloudFormationOutputName = "AwsApiGatewayRestApiId";

module.exports = class ServerlessCognitoAuthScopes {

  constructor(serverless, options) {
    this.serverless = serverless;

    this.options = options;
    this.naming = this.serverless.getProvider(this.serverless.service.provider.name).naming;

    this.stage = this.options.stage || this.serverless.service.provider.stage;

    this._beforeDeploy = this.beforeDeploy.bind(this)
    this._afterDeploy = this.afterDeploy.bind(this)

    this.apiUpdatesNeedDeployed = false;
    this.apiGatewayMethodsToUpdate = [];

    this.hooks = {
      'before:package:finalize': this._beforeDeploy,
      'after:deploy:deploy': this._afterDeploy
    };
  }

  beforeDeploy() {
    this.cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;

    // The default rest API reference
    let restApiId = { Ref: 'ApiGatewayRestApi' };

    // Use the provider API gateway if one has been provided.
    if (this.serverless.service.provider.apiGateway && this.serverless.service.provider.apiGateway.restApiId) {
      restApiId = this.serverless.service.provider.apiGateway.restApiId
    }

    // Add models to method resources
    this.serverless.service.getAllFunctions().forEach(functionName => {
      const func = this.serverless.service.getFunction(functionName);
      func.events.forEach(this._updateCfTemplateFromHttp.bind(this));
    });

    this.cfTemplate.Outputs[ApiGatewayCloudFormationOutputName] = {
      Description: 'API ID',
      Value: restApiId,
    };
  }

  async afterDeploy() {
    const stackName = this.provider.naming.getStackName(this.stage);
    const response = await this.serverless.providers.aws.request('CloudFormation', 'describeStacks', { StackName: stackName });

    const stackOutputs = response.Stacks[0].Outputs

    const restApiId = stackOutputs.find(x => x.OutputKey === ApiGatewayCloudFormationOutputName).OutputValue;

    // this._consoleLog(stackOutputs);

    // this._consoleLog(this.apiGatewayMethodsToUpdate);

    const methodsToUpdate = this.apiGatewayMethodsToUpdate.map(x => this._toApiGatewayUpdateMethodParam(x, restApiId, stackOutputs));

    const toMethodUpdateResponsePromise = this._updateApiGatewayMethod.bind(this);
    await Promise.all(methodsToUpdate.map(toMethodUpdateResponsePromise));

    if (this.apiUpdatesNeedDeployed) {
      this._consoleLog(`Rest API methods have been updated. Creating deployment for API ${restApiId}...`);
      await this.serverless.providers.aws.request(
        'APIGateway',
        'createDeployment',
        {
          restApiId,
          cacheClusterEnabled: false,
          stageName: this.stage,
          stageDescription: 'Adding Cognito Authorization scopes from serverless-plugin-cognito-auth-scopes plugin.'
        });
      this._consoleLog('Deployment has been created.');
    } else {
      this._consoleLog(`Rest API methods have not been updated. Moving on.`);
    }
  }

  _consoleLog(message) {
    this.serverless.cli.consoleLog(`Serverless: \u001B[33m${message}\u001B[39m`);
  }

  _updateCfTemplateFromHttp(event) {
    if (event.http && event.http.authorizer && event.http.cognito && event.http.cognito.scopes) {
      const resourceName = this.provider.naming.normalizePath(event.http.path);
      const resourceId = this.provider.naming.getResourceLogicalId(event.http.path);
      const methodLogicalId = this.provider.naming.getMethodLogicalId(resourceName, event.http.method);

      const cfOutputName = `${methodLogicalId}ResourceId`;

      // this._consoleLog(this.cfTemplate);

      this.cfTemplate.Outputs[cfOutputName] = {
        Value: { Ref: resourceId },
      }

      this.apiGatewayMethodsToUpdate.push({
        cfOutputName,
        httpMethod: event.http.method,
        authorizationScopes: event.http.cognito.scopes
      });
    }
  }

  async _updateApiGatewayMethod(method) {

    // this._consoleLog(method);

    this._consoleLog(`Checking to see that method ${method.resourceId} has expected Authorization Scopes...`);
    const describeResponse = await this.serverless.providers.aws.request(
      'APIGateway',
      'getMethod',
      {
        httpMethod: method.httpMethod.toUpperCase(),
        resourceId: method.resourceId,
        restApiId: method.restApiId
      }
    );

    // this._consoleLog(describeResponse);

    if (describeResponse.authorizationScopes === method.authorizationScopes) {
      this._consoleLog(`hm-serverless-plugin-cognito-auth-scopes: ${this._toYellow(`Method ${method.resourceId} has expected Authorization Scopes. Moving on.`)}`);
      return;
    }

    this.apiUpdatesNeedDeployed = true;
    this._consoleLog(`Method ${method.resourceId} does not have expected Authorization Scopes. Updating...`);

    const updateMethodParams = {
      httpMethod: method.httpMethod.toUpperCase(),
      resourceId: method.resourceId,
      restApiId: method.restApiId,
      patchOperations: [
        {
          op: "replace",
          path: "/authorizationScopes",
          value: JSON.stringify(method.authorizationScopes)
        }
      ]
    }

    await this.serverless.providers.aws.request('APIGateway', 'updateMethod', updateMethodParams);
    this._consoleLog(`Method ${method.resourceId} has been updated.`);
  }

  _toApiGatewayUpdateMethodParam(x, restApiId, stackOutputs) {
    return {
      resourceId: stackOutputs.find(y => y.OutputKey === x.cfOutputName).OutputValue,
      httpMethod: x.httpMethod,
      restApiId,
      authorizationScopes: x.authorizationScopes
    }
  }

  _toYellow(message) {
    return `\u001B[33m${message}\u001B[39m`;
  }
}
