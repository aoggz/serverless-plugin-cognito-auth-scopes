
# hm-serverless-plugin-cognito-auth-scopes

Plugin for the serverless framework to support adding Cognito custom scopes to API Gateway resource methods

## Usage

To enable this plugin to add Authorization scopes to your API Gateway methods, make sure to add the plugin to your `Serverless.yml`:

```yml
plugins:
  - @zoll/serverless-cloudformation-sub-variables
```

Then, just add the `cognito/scopes` property to your http events within each function configuration:

```yml
functions:
  teleport:
    handler: src/handlers/rick.teleport
    events:
      - http:
          path: v1/dimensions/{dimensionId}/teleport
          method: post
          authorizer:
            arn: arn:aws:cognito-idp:us-east-1:xxxxxxxxxxxx:userpool/us-east-1_xxxxxxxxx
          cognito:
            scopes:
              - https://rick-c137-dev.com/dimensions.travel
```

With that configuration, this plugin will configure API Gateway to ensure that the `POST` method for the `v1/dimensions/{dimensionId}/teleport` resource validates that `access_token`s used to access it contain the `https://rick-c137-dev.com/dimensions.travel` scope.