
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
    try {
      const stackName = this.naming.getStackName(this.stage);
      const response = await this.serverless.providers.aws.request('CloudFormation', 'describeStacks', { StackName: stackName });
      const stackOutputs = response.Stacks[0].Outputs

      const restApiId = stackOutputs.find(this._isApiGatewayCloudFormationOutput).OutputValue;

      // Gather ids required to perform update to API Gateway methods
      const methodsToUpdate = this.apiGatewayMethodsToUpdate.map(x => this._toApiGatewayUpdateMethodParam(x, restApiId, stackOutputs));

      // 
      await Promise.all(methodsToUpdate.map(this._asUpdateApiGatewayPromise.bind(this)));

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
    } catch (err) {
      this._consoleLog(`An error was encountered...`);
      throw new Error(err.toString());
    }
  }

  _consoleLog(message) {
    this.serverless.cli.consoleLog(`hm-sls-plugin-cognito-auth-scopes: \u001B[33m${message}\u001B[39m`);
  }

  _updateCfTemplateFromHttp(event) {
    if (event.http && event.http.authorizer && event.http.cognito && event.http.cognito.scopes) {
      const resourceName = this.naming.normalizePath(event.http.path);
      const resourceId = this.naming.getResourceLogicalId(event.http.path);
      const methodLogicalId = this.naming.getMethodLogicalId(resourceName, event.http.method);

      const cfOutputName = `${methodLogicalId}ResourceId`;

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

  async _asUpdateApiGatewayPromise(method) {

    this._consoleLog(`Checking to see that method ${method.resourceId} has the Authorization Scopes ${method.authorizationScopes.join(", ")}...`);
    const getMethodResponse = await this._getApiGatewayMethod(method.httpMethod, method.resourceId, method.restApiId);

    if (getMethodResponse.authorizationScopes.join() === method.authorizationScopes.join()) {
      this._consoleLog(`Method ${method.resourceId} has expected Authorization Scopes. Moving on.`);
      return;
    }

    this.apiUpdatesNeedDeployed = true;
    this._consoleLog(`Method ${method.resourceId} does not have expected Authorization Scopes. Updating...`);

    await this._updateApiGatewayMethodAuthorizationScopes(method.httpMethod, method.resourceId, method.restApiId, method.authorizationScopes);
    this._consoleLog(`Method ${method.resourceId} has been updated.`);
  }

  _getApiGatewayMethod(httpMethod, resourceId, restApiId) {
    return this.serverless.providers.aws.request(
      'APIGateway',
      'getMethod',
      {
        httpMethod: httpMethod.toUpperCase(),
        resourceId,
        restApiId
      }
    )
  }

  _isApiGatewayCloudFormationOutput(output) {
    return output.OutputKey === ApiGatewayCloudFormationOutputName;
  }

  _updateApiGatewayMethodAuthorizationScopes(httpMethod, resourceId, restApiId, authorizationScopes) {
    return this.serverless.providers.aws.request(
      'APIGateway',
      'updateMethod',
      {
        httpMethod: httpMethod.toUpperCase(),
        resourceId,
        restApiId,
        patchOperations: [
          {
            op: "add",
            path: "/authorizationScopes",
            value: authorizationScopes.join()
          }
        ]
      });
  }

  _toApiGatewayUpdateMethodParam(x, restApiId, stackOutputs) {
    return {
      resourceId: stackOutputs.find(y => y.OutputKey === x.cfOutputName).OutputValue,
      httpMethod: x.httpMethod,
      restApiId,
      authorizationScopes: x.authorizationScopes
    }
  }
}
