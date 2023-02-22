# Doctor Job 

Doctor Job is built to allow you to easily create jobs as part of transactions in Prisma.
It was somewhat inspired by the problems mentioned in [this article](https://brandur.org/job-drain).
Those problems are that when we write data to a DB, we sometimes want to create a job associated with that data. 
Naively we might try to write the data, then use that data to send a job to some external queue.
However we can hit failure modes where the data is created, but the job is not queued, or the job is created, but references non existent data - even if we are using transactions.
More details can be found in the article.

We can get some more safety if we store the jobs to be queued in the same DB as data, and only later process send them to an external queue.
This is because we can rely on transactions to ensure that creating data and jobs will always succeed or fail together.


## Prerequisites
You will need to use Prisma.. You will also need to enable interactive transactions by adding interactiveTransactions in the generator of your Prisma Schema:

```
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["interactiveTransactions"]
}
```

You will also need a jobs table and a dead letter queue table. You have some leeway in how they are structured.
Mine look something like this.

```
model Job {
  id    String @id @default(cuid())

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  data String
}

model DeadLetters {
  id    String @id @default(cuid())

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  data String
}
``` 

## Using It


Here we set up a type for our jobs, and a function that actually handles them.
In this case I've assumed we handle them directly in the same code base - but you could also
just drain the jobs into an external job queue.
```
export type ParsedJob =
  | {
      type: "sendClientLoginLink";
      options: {
        clientId: string;
      };
    }
  | {
      type: "reticulateSplines";
      options: {
        target: string;
      };
    };

export const handleParsedJobs = async (job: ParsedJob) => {
  if (job.type === "sendClientLoginLink") {
    const client = await getClientById(job.options.clientId);
    invariant(client);

    const loginToken = await createMagicLinkLoginToken(job.options.clientId);

    sendClientLoginLinkEmail(client.email, client.id, loginToken);
  } else if (job.type === "reticulateSplines") {
    throw new Error("reticulateSplines is not implemented yet!");
  } else {
    throw new Error(`found an unknown job ${job}`);
  }
};
```

Here we set up a function that can take the data we have in Prisma
and parse it into the format used by our function above
```
import * as E from "fp-ts/Either";
import type { Job, DeadLetters } from "@prisma/client";

const parseJob = (job: Job): E.Either<Error, ParsedJob> => {
  // You might want to parse your data slightly better than this ;)
  return E.right(JSON.parse(job.data));
};
```

Then we can set up our instance of DoctorJob, with a couple more functions passed in 
to handle things like creating and retrieving jobs and deadletters.
```
const doctorJob = new DoctorJob<ParsedJob, Job, DeadLetters>({
  prismaClient,
  parseJob,
  getJob: async (client) => {
    const job = await client.job.findFirst({
      orderBy: { createdAt: "asc" },
    });

    if (job === null) {
      return O.none
    } else {
      return O.some(job)
    }
  },
  },
  createJob: async (tx, data) => {
    await tx.job.create({
      data: {
        data,
      },
    });
  },
  getDeadLetters: async (client) => {
    return client.deadLetters.findMany();
  },
  createDeadLetter: async (client, job) => {
    await client.deadLetters.create({
      data: {
        id: job.id,
        data: job.data,
      },
    });
  },
});
```

Then we can start running the `handleParsedJobs` function in a loop.

```
setInterval(() => doctorJob.run(handleParsedJobs), 1000);
```

Finally we can start adding jobs to the queue like so:
```
async function createLoginLinkForClient(email: string) {
  return await doctorJob.queue(async () => {
    const client = await prisma.client.findUniqueOrThrow({ where: { email } });
    const job = {
      type: "sendClientLoginLink" as const,
      options: {
        clientId: client.id,
      },
    };

    return { data: null, job };
  });
}
```

## Disclaimer
This is extracted from a personal project, has not been code reviewed, and almost certainly is not something you want to use. There will probably be breaking changes.
